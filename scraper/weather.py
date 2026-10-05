#!/usr/bin/env python3
"""
Daily weather forecast for the Today tab: the Turkish State Meteorological Service (MGM) forecast for
the campus district (Tuzla, Istanbul), a handful of days ahead.

Source: the JSON service behind https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il=İstanbul&ilce=Tuzla
  https://servis.mgm.gov.tr/web/merkezler?il=İstanbul&ilce=Tuzla       -> the station numbers for that district
  https://servis.mgm.gov.tr/web/tahminler/gunluk?istno=<gunlukTahminIstNo>  -> the daily forecast, "Gun1".."Gun5"
The service only answers a request that looks like it comes from mgm.gov.tr, hence the Origin / Referer headers.

NOTE: written from how that service is commonly described, not from a live response — run
  python scraper/weather.py --probe
once and read what it prints (it shows the raw JSON of both calls and what was extracted). The key names are
looked up loosely (anything like tarih* / enDusuk* / enYuksek* / hadise* ending in the day number), so a small
rename on their side shouldn't break it; a failed run leaves the previous data/weather.json alone.

  python scraper/weather.py                    # Tuzla, writes data/weather.json
  python scraper/weather.py --il İstanbul --ilce Kadıköy
  python scraper/weather.py --probe            # print the raw responses and the parsed days, write nothing
  python scraper/weather.py --json saved.json  # parse a saved daily-forecast response (no network)

Writes data/weather.json: {"updated", "il", "ilce", "source", "days": [{"date", "min", "max", "code", "text"}]}.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE = "https://servis.mgm.gov.tr/web"
HEADERS = {"Origin": "https://www.mgm.gov.tr", "Referer": "https://www.mgm.gov.tr/",
           "Accept": "application/json, text/plain, */*"}
ISTANBUL = ZoneInfo("Europe/Istanbul")

# MGM's weather-event codes ("hadise") -> the icon the app draws, and an English label.
EVENTS = {
    "A": ("sun", "Clear"),
    "AB": ("partly", "Mostly clear"),
    "PB": ("partly", "Partly cloudy"),
    "CB": ("cloud", "Cloudy"),
    "HY": ("rain", "Light rain"),
    "Y": ("rain", "Rain"),
    "KY": ("rain", "Heavy rain"),
    "SY": ("rain", "Showers"),
    "GSY": ("storm", "Thunderstorms"),
    "KGY": ("storm", "Thunderstorms"),
    "K": ("snow", "Snow"),
    "HK": ("snow", "Light snow"),
    "YK": ("snow", "Heavy snow"),
    "KKY": ("snow", "Sleet"),
    "KY2": ("rain", "Heavy rain"),
    "S": ("fog", "Fog"),
    "DS": ("fog", "Haze"),
    "R": ("wind", "Windy"),
    "GKR": ("wind", "Strong wind"),
    "SGK": ("rain", "Showers"),
    "MSS": ("fog", "Mist"),
}


def day_keys(row: dict) -> dict[int, dict[str, str]]:
    """{1: {'date': key, 'min': key, 'max': key, 'event': key}, …} found by loose key names."""
    by_day: dict[int, dict[str, str]] = {}
    for key in row:
        m = re.search(r"(\d+)$", key)
        if not m:
            continue
        n = int(m.group(1))
        low = key.lower()
        slot = None
        if "tarih" in low or "date" in low:
            slot = "date"
        elif ("dusuk" in low or "düşük" in low or "min" in low) and "nem" not in low:
            slot = "min"
        elif ("yuksek" in low or "yüksek" in low or "max" in low) and "nem" not in low:
            slot = "max"
        elif "hadise" in low or "event" in low:
            slot = "event"
        if slot:
            by_day.setdefault(n, {}).setdefault(slot, key)
    return by_day


def local_date(value) -> str | None:
    """'2026-10-06T00:00:00.000Z' (UTC midnight, or Istanbul midnight written as 21:00Z) -> the Istanbul date."""
    if not value:
        return None
    text = str(value).strip()
    try:
        when = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None
    if when.tzinfo is None:
        return when.date().isoformat()
    return when.astimezone(ISTANBUL).date().isoformat()


def number(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return int(round(n)) if abs(n) < 100 else None      # MGM uses -9999 for "no value"


def parse_daily(payload) -> list[dict]:
    """The daily-forecast response (a list with one row, or the row itself) -> one dict per day."""
    row = payload[0] if isinstance(payload, list) and payload else payload
    if not isinstance(row, dict):
        return []
    days = []
    for n, keys in sorted(day_keys(row).items()):
        date = local_date(row.get(keys.get("date")))
        if not date or any(d["date"] == date for d in days):      # "Gun0" is today again (same as Gun1)
            continue
        code = str(row.get(keys.get("event"), "") or "").strip().upper()
        icon, text = EVENTS.get(code, ("cloud", code or "—"))
        days.append({"date": date, "min": number(row.get(keys.get("min"))), "max": number(row.get(keys.get("max"))),
                     "code": icon, "text": text, "event": code})
    return days


def station_number(payload) -> int | None:
    """From the merkezler answer: the number to ask the daily forecast with."""
    rows = payload if isinstance(payload, list) else [payload]
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("gunlukTahminIstNo", "gunlukTahminIstno", "istNo", "merkezId"):
            if row.get(key):
                return int(row[key])
        for key, value in row.items():
            if "gunluk" in key.lower() and "ist" in key.lower() and value:
                return int(value)
    return None


def fetch(session, url: str):
    res = session.get(url, headers=HEADERS, timeout=30)
    res.raise_for_status()
    return res.json()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--il", default="İstanbul")
    ap.add_argument("--ilce", default="Tuzla")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--probe", action="store_true", help="print the raw responses and the parsed days; write nothing")
    ap.add_argument("--json", help="parse a saved daily-forecast response and print the days (no network)")
    args = ap.parse_args(argv)

    if args.json:
        days = parse_daily(json.loads(Path(args.json).read_text(encoding="utf-8")))
        print(json.dumps(days, ensure_ascii=False, indent=1))
        return 0 if days else 1

    from scrape import make_session
    session = make_session()
    out = Path(args.data) / "weather.json"
    try:
        merkez = fetch(session, f"{BASE}/merkezler?il={args.il}&ilce={args.ilce}")
        if args.probe:
            print("merkezler:", json.dumps(merkez, ensure_ascii=False)[:1500])
        ist = station_number(merkez)
        if not ist:
            raise RuntimeError(f"no station number in the merkezler answer for {args.il}/{args.ilce}")
        daily = fetch(session, f"{BASE}/tahminler/gunluk?istno={ist}")
        if args.probe:
            print("gunluk:", json.dumps(daily, ensure_ascii=False)[:2500])
        days = parse_daily(daily)
        if not days:
            raise RuntimeError("the daily forecast had no days I could read")
    except Exception as exc:                       # keep yesterday's file: a stale forecast beats none
        print(f"weather: failed ({str(exc)[:200]}) — leaving {out.name} as it is", file=sys.stderr)
        return 0 if not args.probe else 1
    if args.probe:
        print(json.dumps(days, ensure_ascii=False, indent=1))
        return 0
    out.write_text(json.dumps({
        "schema": 1, "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "il": args.il, "ilce": args.ilce, "source": f"https://www.mgm.gov.tr/tahmin/il-ve-ilceler.aspx?il={args.il}&ilce={args.ilce}",
        "days": days}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{out}: {len(days)} days, {days[0]['date']} .. {days[-1]['date']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
