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
from scrape import clean, make_session  # noqa: E402

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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", help="term code; defaults to the newest in data/terms.json")
    ap.add_argument("--crns", nargs="*", help="only these CRNs")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--rate", type=float, default=4.0, help="requests per second overall (default 4)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--auto", action="store_true", help="only run in registration/add-drop windows or once a day")
    ap.add_argument("--html", help="parse a saved detail page and print the result")
    args = ap.parse_args(argv)

    if args.html:
        print(parse_detail(Path(args.html).read_text(encoding="utf-8", errors="replace")))
        return 0

    data_dir = Path(args.data)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    term = args.term or index["terms"][0]["code"]
    out_path = data_dir / f"{term}-seats.json"
    previous = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else None

    if args.auto:
        cal_path = data_dir / f"{term}-calendar.json"
        calendar = json.loads(cal_path.read_text(encoding="utf-8")) if cal_path.exists() else {}
        now = dt.datetime.now(dt.timezone.utc)
        today = (now + dt.timedelta(hours=3)).date()          # Istanbul
        last = dt.datetime.fromisoformat(previous["updated"].replace("Z", "+00:00")) if previous else None
        if not in_window(calendar, today) and last and now - last < dt.timedelta(hours=23):
            print("outside registration and add/drop, and refreshed within a day — skipping")
            return 0

    schedule = json.loads((data_dir / f"{term}.json").read_text(encoding="utf-8"))
    crns = args.crns or [s["crn"] for c in schedule["courses"] for comp in c["components"] for s in comp["sections"]]
    print(f"{term}: {len(crns)} sections")

    session = make_session()
    gap = 1.0 / max(args.rate, 0.1)
    lock = threading.Lock()
    clock = {"next": time.monotonic()}
    seats: dict[str, list[int]] = dict(previous["seats"]) if previous and args.crns else {}
    failures = 0

    def fetch(crn: str):
        nonlocal failures
        with lock:
            wait = clock["next"] - time.monotonic()
            clock["next"] = max(clock["next"], time.monotonic()) + gap
        if wait > 0:
            time.sleep(wait)
        try:
            res = session.get(DETAIL_URL.format(term=term, crn=crn), timeout=30)
            res.raise_for_status()
            parsed = parse_detail(res.text)
        except Exception as exc:
            with lock:
                failures += 1
            print(f"  {crn}: {exc}", file=sys.stderr)
            return
        if parsed:
            row = parsed["seats"] + parsed.get("waitlist", [])
            with lock:
                seats[crn] = row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(fetch, crns))

    if not seats:
        print("no seat data came back", file=sys.stderr)
        return 1
    out = {"schema": 1, "term": term,
           "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "fields": ["capacity", "taken", "remaining", "waitCapacity", "waiting", "waitRemaining"],
           "seats": seats}
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{out_path}: {len(seats)} sections, {failures} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
