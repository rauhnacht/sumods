#!/usr/bin/env python3
"""
Seat availability for SUMods: capacity, taken and remaining seats per CRN (plus waitlist).

Source: BannerWeb's detailed class information page, one per section
  https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_detail_sched?term_in=202601&crn_in=13602

  python scraper/seats.py                          # every CRN of the newest term
  python scraper/seats.py --term 202601 --crns 13602 10190
  python scraper/seats.py --auto                   # skip unless it's a registration window or a day has passed
  python scraper/seats.py --html detail.html       # parse a saved page

Writes data/<term>-seats.json. One run is one request per section, so it is rate limited
(default 4 requests a second across 4 workers). --auto runs every time during registration
and add/drop (dates from data/<term>-calendar.json) and at most once a day otherwise, which
is what the GitHub workflow uses.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import clean, make_session, active_term_code  # noqa: E402


def default_term(index: dict, data_dir) -> str:
    """The term that's actually running now, if we have data for it; else the newest listed.

    A term can appear in BannerWeb's dropdown (and so in terms.json, sorted by code) before
    its classes start — e.g. next Spring shows up while this Fall is still in session, and
    its higher code would otherwise look like "the current term" by pure sorting. That's
    wrong for anything tracking something live, like seats or finals.
    """
    codes = {t["code"] for t in index["terms"]}
    active = active_term_code()
    if active in codes and (data_dir / f"{active}.json").exists():
        return active
    return index["terms"][0]["code"]

DETAIL_URL = "https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_detail_sched?term_in={term}&crn_in={crn}"
ROW_LABELS = {"seats": "seats", "waitlist seats": "waitlist", "cross list seats": "crosslist"}


def parse_detail(html: str) -> dict | None:
    """The 'Registration Availability' table: rows Seats / Waitlist Seats × Capacity, Actual, Remaining."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, list[int]] = {}
    for tr in soup.find_all("tr"):
        head = tr.find("th")
        label = clean(head.get_text(" ")).lower().rstrip(":") if head else ""
        key = ROW_LABELS.get(label)
        if not key:
            continue
        values = []
        for td in tr.find_all("td"):
            m = re.fullmatch(r"-?\d+", clean(td.get_text(" ")))
            if m:
                values.append(int(m.group(0)))
        if len(values) >= 3:
            out[key] = values[:3]
    if "seats" not in out:
        return None
    return out


def in_window(calendar: dict, today: dt.date) -> bool:
    days = [dt.date.fromisoformat(d) for d in calendar.get("registrationDays", [])]
    if days and days[0] - dt.timedelta(days=1) <= today <= days[-1]:
        return True
    start, end = calendar.get("addDropStart"), calendar.get("addDropEnd") or calendar.get("addDropStart")
    if start and dt.date.fromisoformat(start) <= today <= dt.date.fromisoformat(end):
        return True
    return False


def fast_session(workers: int):
    """Like scrape.make_session, but sized for many threads and quick to give up: one CRN
    that won't answer shouldn't hold a worker for a minute — it keeps its previous value and
    gets another chance next run."""
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = make_session()
    retry = Retry(total=1, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=frozenset(["GET"]))
    session.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=workers, pool_maxsize=workers))
    return session


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", help="term code; defaults to the term in session")
    ap.add_argument("--crns", nargs="*", help="only these CRNs")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--rate", type=float, default=10.0, help="requests per second overall (default 10)")
    ap.add_argument("--workers", type=int, default=16, help="parallel requests (default 16)")
    ap.add_argument("--budget", type=float, default=11.0,
                    help="minutes to spend before writing what we have (default 11; 0 = no limit)")
    ap.add_argument("--auto", action="store_true", help="only run in registration/add-drop windows or once a day")
    ap.add_argument("--html", help="parse a saved detail page and print the result")
    args = ap.parse_args(argv)

    if args.html:
        print(parse_detail(Path(args.html).read_text(encoding="utf-8", errors="replace")))
        return 0

    data_dir = Path(args.data)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    term = args.term or default_term(index, data_dir)
    out_path = data_dir / f"{term}-seats.json"
    previous = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    now = dt.datetime.now(dt.timezone.utc)

    if args.auto:
        cal_path = data_dir / f"{term}-calendar.json"
        calendar = json.loads(cal_path.read_text(encoding="utf-8")) if cal_path.exists() else {}
        today = (now + dt.timedelta(hours=3)).date()          # Istanbul
        full = previous.get("fullPassAt")
        full = dt.datetime.fromisoformat(full.replace("Z", "+00:00")) if full else None
        if not in_window(calendar, today) and full and now - full < dt.timedelta(hours=23) and not previous.get("cursor"):
            print("outside registration and add/drop, and a full pass finished within a day — skipping")
            return 0

    schedule = json.loads((data_dir / f"{term}.json").read_text(encoding="utf-8"))
    everything = [s["crn"] for c in schedule["courses"] for comp in c["components"] for s in comp["sections"]]
    # pick up where the last run stopped, so a pass that doesn't fit one run finishes over the next
    cursor = 0 if args.crns else int(previous.get("cursor") or 0) % max(len(everything), 1)
    crns = args.crns or (everything[cursor:] + everything[:cursor])
    print(f"{term}: {len(crns)} sections, starting at #{cursor}, {args.workers} workers, "
          f"{args.rate:g}/s, budget {args.budget:g} min")

    session = fast_session(args.workers)
    gap = 1.0 / max(args.rate, 0.1)
    lock = threading.Lock()
    clock = {"next": time.monotonic()}
    deadline = time.monotonic() + args.budget * 60 if args.budget > 0 else float("inf")
    seats: dict[str, list[int]] = dict(previous.get("seats") or {})   # failures keep their last value
    attempted = [False] * len(crns)
    counts = {"ok": 0, "failed": 0}
    started = time.monotonic()

    def fetch(i: int):
        if time.monotonic() > deadline:
            return
        with lock:
            wait = clock["next"] - time.monotonic()
            clock["next"] = max(clock["next"], time.monotonic()) + gap
        if wait > 0:
            time.sleep(wait)
        if time.monotonic() > deadline:
            return
        attempted[i] = True
        crn = crns[i]
        try:
            res = session.get(DETAIL_URL.format(term=term, crn=crn), timeout=15)
            res.raise_for_status()
            parsed = parse_detail(res.text)
        except Exception as exc:
            with lock:
                counts["failed"] += 1
            print(f"  {crn}: {str(exc)[:100]}", file=sys.stderr)
            return
        with lock:
            if parsed:
                seats[crn] = parsed["seats"] + parsed.get("waitlist", [])
            counts["ok"] += 1
            done = counts["ok"] + counts["failed"]
            if done % 200 == 0:
                rate = done / max(time.monotonic() - started, 0.001)
                print(f"  {done}/{len(crns)} ({rate:.1f}/s)")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(fetch, range(len(crns))))

    reached = sum(attempted)
    elapsed = time.monotonic() - started
    if not seats:
        print("no seat data came back", file=sys.stderr)
        return 1
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"schema": 1, "term": term, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "fields": ["capacity", "taken", "remaining", "waitCapacity", "waiting", "waitRemaining"],
           "fullPassAt": previous.get("fullPassAt"), "cursor": 0, "seats": seats}
    if not args.crns:
        if reached >= len(crns):
            out["fullPassAt"] = stamp
        else:
            out["cursor"] = (cursor + reached) % len(everything)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{out_path}: {counts['ok']} refreshed, {counts['failed']} failed, "
          f"{reached}/{len(crns)} reached in {elapsed / 60:.1f} min ({reached / max(elapsed, 0.001):.1f}/s)"
          + ("" if reached >= len(crns) else f" — next run continues from #{out['cursor']}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
