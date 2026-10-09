#!/usr/bin/env python3
"""
SUMods seat watcher — a small always-on service that keeps seat counts fresh and sends
phone notifications when a full section opens up.

Same API the Cloudflare worker has, so the site needs only a new URL in config.js:

  GET  /?term=202601&crns=13602,10189
       -> {"term": "...", "updated": "...", "pollSeconds": 10, "seats": {"13602": [cap, taken, left, wcap, waiting, wleft]}}
  POST /watch    {"term": "202601", "crn": "13602", "topic": "<random ntfy topic>", "label": "CS 201 A"}
  POST /unwatch  {"term": "202601", "crn": "13602", "topic": "<same topic>"}
  GET  /health

How it stays fast without hammering BannerWeb: it only polls CRNs somebody is looking at
(asked for in the last 90 s) or has set a notification for. Everything else stays on the
15-minute GitHub snapshot. BannerWeb answers in roughly 5 s per page, so freshness is
(number of watched CRNs x 5 s / workers) — with 8 workers, 100 watched CRNs refresh every ~1 minute
and 10 of them every ~6 s.

Notifications go out through ntfy.sh (free, no account): the site gives each browser a random
topic, the user subscribes to it in the ntfy app, and this service publishes when a watched
section goes from 0 to >0 free seats. Needs: requests, beautifulsoup4.

  python3 server/seats_watcher.py --port 8787
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))

HOT_TTL = 90          # seconds a CRN stays "hot" after someone asked for it
MIN_AGE = 6           # never poll the same CRN more often than this (seconds)
MAX_HOT = 400         # cap on CRNs polled for viewers
MAX_PER_REQUEST = 12
WATCH_DAYS = 45
MAX_WATCHES_PER_TOPIC = 25
TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
SITE = "https://sumods.com"

lock = threading.Lock()
BANNER_SLOTS = threading.BoundedSemaphore(6)   # BannerWeb drops connections beyond ~6 at once
FAIL_PAUSE = 15                                # a CRN that errored waits this long before its next try
cache: dict[tuple[str, str], dict] = {}      # (term, crn) -> {"row": [...] | None, "at": epoch}
hot: dict[tuple[str, str], float] = {}       # (term, crn) -> last requested
watches: dict[str, dict] = {}                # "term:crn" -> {topic: {"label", "since", "armed"}}
STATE_FILE = Path(os.environ.get("SEATS_STATE", "/var/lib/sumods-seats/watches.json"))
FAKE = bool(os.environ.get("SUMODS_FAKE"))   # tests: no network
_session = None
_last_err_log = [0.0]


def session():
    global _session
    if _session is None:
        from seats import fast_session
        _session = fast_session(16)
    return _session


def fetch_row(term: str, crn: str):
    """[cap, taken, left, wait cap, waiting, wait left] or None."""
    if FAKE:
        n = int(time.time() // 5) % 3
        return [30, 30 - n, n, 0, 0, 0]
    from seats import DETAIL_URL, parse_detail
    try:
        with BANNER_SLOTS:
            res = session().get(DETAIL_URL.format(term=term, crn=crn), timeout=15)
        parsed = parse_detail(res.text)
    except Exception as exc:  # noqa: BLE001 — keep the loop alive
        now = time.time()
        if now - _last_err_log[0] > 10:      # one line per 10 s, not one per CRN
            _last_err_log[0] = now
            print(f"{term}/{crn}: {exc.__class__.__name__} (further errors muted for 10 s)", flush=True)
        return None
    if not parsed:
        return None
    return parsed["seats"] + parsed.get("waitlist", [0, 0, 0])


def notify(topic: str, label: str, term: str, crn: str, left: int) -> None:
    if FAKE:
        print(f"[notify] {topic} {label} {crn} left={left}", flush=True)
        return
    import requests
    try:
        requests.post(
            f"https://ntfy.sh/{topic}",
            data=f"{label or crn}: {left} seat{'s' if left != 1 else ''} just opened (CRN {crn}).".encode("utf-8"),
            headers={"Title": "SUMods: a seat opened", "Priority": "high", "Tags": "seat,tada",
                     "Click": f"{SITE}/?crn={crn}"},
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"ntfy failed: {exc.__class__.__name__}", flush=True)


def store(term: str, crn: str, row) -> None:
    key = (term, crn)
    with lock:
        cache[key] = {"row": row if row else cache.get(key, {}).get("row"),
                      "at": time.time() + (0 if row else FAIL_PAUSE), "ok": bool(row)}
        subs = dict(watches.get(f"{term}:{crn}", {}))
    if not row:
        return
    left = row[2]
    changed = False
    for topic, w in subs.items():
        if left <= 0 and not w.get("armed", True):
            w["armed"] = True            # full again: arm for the next opening
            changed = True
        elif left > 0 and w.get("armed", True):
            notify(topic, w.get("label", ""), term, crn, left)
            w["armed"] = False
            changed = True
    if changed:
        save_state()


def load_state() -> None:
    if STATE_FILE.exists():
        try:
            watches.update(json.loads(STATE_FILE.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass


def save_state() -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with lock:
            data = json.dumps(watches)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(data, encoding="utf-8")
        tmp.replace(STATE_FILE)
    except OSError as exc:
        print(f"could not save watches: {exc}", flush=True)


def prune_watches() -> None:
    cutoff = time.time() - WATCH_DAYS * 86400
    with lock:
        for key in list(watches):
            for topic in list(watches[key]):
                if watches[key][topic].get("since", 0) < cutoff:
                    del watches[key][topic]
            if not watches[key]:
                del watches[key]


def poll_loop(workers: int) -> None:
    pool = ThreadPoolExecutor(max_workers=workers)
    last_prune = 0.0
    while True:
        now = time.time()
        if now - last_prune > 3600:
            prune_watches()
            save_state()
            last_prune = now
        with lock:
            wanted = {k for k, t in hot.items() if now - t < HOT_TTL}
            for k in list(hot):
                if now - hot[k] > HOT_TTL * 4:
                    del hot[k]
            if len(wanted) > MAX_HOT:
                wanted = set(sorted(wanted, key=lambda k: -hot[k])[:MAX_HOT])
            for wk in watches:
                term, crn = wk.split(":")
                wanted.add((term, crn))
            due = [k for k in wanted if now - cache.get(k, {}).get("at", 0) >= MIN_AGE]
            due.sort(key=lambda k: cache.get(k, {}).get("at", 0))      # stalest first
        if not due:
            time.sleep(0.5)
            continue
        batch = due[: workers * 2]
        list(pool.map(lambda k: store(k[0], k[1], fetch_row(*k)), batch))


class Handler(BaseHTTPRequestHandler):
    server_version = "sumods-seats"

    def log_message(self, *args):  # quiet
        pass

    def _send(self, body, status=200, cache_control="no-store"):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            with lock:
                self._send({"ok": True, "cached": len(cache), "hot": len(hot), "watches": sum(len(v) for v in watches.values())})
            return
        q = parse_qs(url.query)
        term = (q.get("term") or [""])[0]
        crns = list(dict.fromkeys(c for c in ((q.get("crns") or [""])[0]).split(",") if re.fullmatch(r"\d{5}", c)))[:MAX_PER_REQUEST]
        if not re.fullmatch(r"\d{6}", term) or not crns:
            self._send({"error": "term (6 digits) and crns (comma-separated) are required"}, 400)
            return
        now = time.time()
        with lock:
            for c in crns:
                hot[(term, c)] = now
            missing = [c for c in crns if (term, c) not in cache or 30 < now - cache[(term, c)]["at"] < 3600]
        if missing:   # first look (or a stale one): answer with a fresh read instead of nothing
            with ThreadPoolExecutor(max_workers=len(missing)) as ex:
                list(ex.map(lambda c: store(term, c, fetch_row(term, c)), missing))
        with lock:
            seats = {c: (cache.get((term, c)) or {}).get("row") for c in crns}
        self._send({"term": term, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "pollSeconds": 10, "seats": seats})

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/watch", "/unwatch"):
            self._send({"error": "not found"}, 404)
            return
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 4096)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            self._send({"error": "bad json"}, 400)
            return
        term, crn, topic = str(body.get("term", "")), str(body.get("crn", "")), str(body.get("topic", ""))
        if not (re.fullmatch(r"\d{6}", term) and re.fullmatch(r"\d{5}", crn) and TOPIC_RE.match(topic)):
            self._send({"error": "term, crn and a 16-64 char topic are required"}, 400)
            return
        key = f"{term}:{crn}"
        with lock:
            if path == "/watch":
                mine = sum(1 for subs in watches.values() if topic in subs)
                if topic not in watches.get(key, {}) and mine >= MAX_WATCHES_PER_TOPIC:
                    self._send({"error": f"at most {MAX_WATCHES_PER_TOPIC} watched sections"}, 429)
                    return
                row = (cache.get((term, crn)) or {}).get("row")
                watches.setdefault(key, {})[topic] = {
                    "label": str(body.get("label", ""))[:60], "since": time.time(),
                    "armed": not (row and row[2] > 0)}      # already open now → don't fire; arm when it fills
            else:
                watches.get(key, {}).pop(topic, None)
                if not watches.get(key, True):
                    watches.pop(key, None)
        save_state()
        self._send({"ok": True})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--workers", type=int, default=6, help="parallel BannerWeb requests (default 6)")
    args = ap.parse_args()
    load_state()
    threading.Thread(target=poll_loop, args=(args.workers,), daemon=True).start()
    print(f"seats watcher on {args.host}:{args.port}, {args.workers} workers", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
