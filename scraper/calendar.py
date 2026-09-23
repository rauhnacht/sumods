#!/usr/bin/env python3
"""
Academic calendar for SUMods: when a term's classes start and end, when finals run,
and which days are off. The site uses this for the .ics export (and for showing the
term's shape); without it the app asks the student for the two dates.

Source: https://www.sabanciuniv.edu/tr/akademik-takvim?b=<year>&c=16&d=tr
The page lists one row per event with a column per student group, in date order, so
the first "DERSLERİN BAŞLAMASI" is the fall term, the second spring, the third summer.

  python scraper/calendar.py                 # the year of the newest term in data/
  python scraper/calendar.py --year 2026
  python scraper/calendar.py --level LİSANSÜSTÜ
  python scraper/calendar.py --html saved.html --year 2026   # parse a saved page

Writes data/<term>-calendar.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import clean, make_session, term_name  # noqa: E402

CALENDAR_URL = "https://www.sabanciuniv.edu/tr/akademik-takvim?b={year}&c=16&d=tr"
MONTHS = {"oca": 1, "şub": 2, "sub": 2, "mar": 3, "nis": 4, "may": 5, "haz": 6,
          "tem": 7, "ağu": 8, "agu": 8, "eyl": 9, "eki": 10, "kas": 11, "ara": 12}
CLASSES_START = "DERSLERİN BAŞLAMASI"
CLASSES_END = "DERSLERİN SONA ERMESİ"
EXAMS = "DÖNEM SONU SINAVLARI"
REGISTRATION = "DERS KAYITLARI"
ADD_DROP = "DERS EKLEME-BIRAKMA"
HOLIDAY_HINTS = ("resmi tatil", "yeni yıl tatili", "bayramı tatili", "dönem içi tatili")
DATE_RE = re.compile(r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3,9})\.?(?:\s+(\d{4}))?")


def upper_tr(text: str) -> str:
    return text.replace("i", "İ").replace("ı", "I").upper()


def parse_dates(text: str) -> list[str]:
    """'28 Eyl 2026' -> [date]; '04-13 Oca 2027' and '29 May - 08 Haz 2027' -> [start, end]."""
    items: list[list] = []
    for m in DATE_RE.finditer(clean(text)):
        first, second, month_name, year = m.groups()
        month = MONTHS.get(month_name[:3].lower())
        if not month:
            continue
        items.append([int(first), int(second) if second else None, month, int(year) if year else None])
    dated = [i for i, x in enumerate(items) if x[3]]
    if not dated:
        return []
    for i, x in enumerate(items):          # '29 May - 08 Haz 2027': the year sits on the later half
        if x[3]:
            continue
        following = next((k for k in dated if k > i), None)
        x[3] = items[following][3] if following is not None else items[dated[-1]][3]
    out: list[str] = []
    for first, second, month, year in items:
        try:
            out.append(dt.date(year, month, first).isoformat())
            if second:
                out.append(dt.date(year, month, second).isoformat())
        except ValueError:
            continue
    return out


def parse_calendar(html: str, level: str = "LİSANS") -> dict:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    rows: list[tuple[str, list[str]]] = []
    column = None
    for tr in soup.find_all("tr"):
        cells = [clean(c.get_text(" ")) for c in tr.find_all(["th", "td"])]
        if not cells:
            continue
        if column is None:
            for i, cell in enumerate(cells):
                if upper_tr(cell).startswith(upper_tr(level)):
                    column = i
                    break
            if column is not None:
                continue
        rows.append((cells[0], cells))

    if column is None:
        raise SystemExit(f"could not find a '{level}' column in the calendar table")

    def value(cells: list[str]) -> str:
        return cells[column] if column < len(cells) else ""

    starts, ends, exams, holidays, registrations, add_drops = [], [], [], [], [], []
    for label, cells in rows:
        flat = upper_tr(label)
        dates = parse_dates(value(cells))
        if not dates:
            continue
        if flat.startswith(upper_tr(CLASSES_START)):
            starts.append(dates[0])
        elif flat.startswith(upper_tr(CLASSES_END)):
            ends.append(dates[-1])
        elif flat.startswith(upper_tr(EXAMS)):
            exams.append((dates[0], dates[-1]))
        elif flat.startswith(upper_tr(REGISTRATION)):
            registrations.append((dates[0], dates[-1]))
        elif flat.startswith(upper_tr(ADD_DROP)):
            add_drops.append((dates[0], dates[-1]))
        elif any(h in label.lower() for h in HOLIDAY_HINTS):
            name = re.sub(r"\s*\(.*?\)\s*", " ", label.split("Not:")[0]).strip(" .")
            span = (dt.date.fromisoformat(dates[0]), dt.date.fromisoformat(dates[-1]))
            day = span[0]
            while day <= span[1]:
                holidays.append({"date": day.isoformat(), "name": name})
                day += dt.timedelta(days=1)
    return {"starts": starts, "ends": ends, "exams": exams, "holidays": holidays,
            "registrations": registrations, "addDrops": add_drops}


def terms_from(parsed: dict, year: int) -> list[dict]:
    """Rows come in date order: fall, then spring, then summer."""
    out = []
    for i, part in enumerate(("01", "02", "03")):
        if i >= len(parsed["starts"]) or i >= len(parsed["ends"]):
            break
        code = f"{year}{part}"
        start, end = parsed["starts"][i], parsed["ends"][i]
        entry = {
            "schema": 1, "term": code, "name": term_name(code),
            "classesStart": start, "classesEnd": end,
            "source": CALENDAR_URL.format(year=year),
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if i < len(parsed["exams"]):
            entry["examsStart"], entry["examsEnd"] = parsed["exams"][i]
        # registration for a term happens before its classes start: take the last window before them
        before = [r for r in parsed.get("registrations", []) if r[0] <= start]
        if before:
            first, last = before[-1]
            days, day = [], dt.date.fromisoformat(first)
            while day <= dt.date.fromisoformat(last):
                if day.weekday() < 5:
                    days.append(day.isoformat())
                day += dt.timedelta(days=1)
            entry["registrationDays"] = days
        drops = [r for r in parsed.get("addDrops", []) if start <= r[0] <= end]
        if drops:
            entry["addDropStart"], entry["addDropEnd"] = drops[0]
        entry["holidays"] = [h for h in parsed["holidays"] if start <= h["date"] <= (entry.get("examsEnd") or end)]
        out.append(entry)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, help="academic year start, e.g. 2026 for 2026-2027")
    ap.add_argument("--level", default="LİSANS", help="calendar column (default LİSANS)")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--html", help="parse a saved calendar page instead of fetching")
    ap.add_argument("--dump", help="save the fetched page here")
    ap.add_argument("--print", action="store_true", help="show what was parsed, write nothing")
    args = ap.parse_args(argv)

    data_dir = Path(args.data)
    year = args.year
    if not year:
        index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
        year = int(index["terms"][0]["code"][:4])

    if args.html:
        html = Path(args.html).read_text(encoding="utf-8", errors="replace")
    else:
        session = make_session()
        res = session.get(CALENDAR_URL.format(year=year), timeout=60)
        res.raise_for_status()
        html = res.text
        if args.dump:
            Path(args.dump).write_text(html, encoding="utf-8")

    terms = terms_from(parse_calendar(html, args.level), year)
    if not terms:
        print("nothing parsed — save the page with --dump and check it with --html", file=sys.stderr)
        return 1
    for entry in terms:
        line = (f'{entry["term"]} {entry["name"]}: classes {entry["classesStart"]} → {entry["classesEnd"]}'
                f'{", finals " + entry["examsStart"] + " → " + entry["examsEnd"] if entry.get("examsStart") else ""}'
                f', {len(entry["holidays"])} days off')
        print(line)
        if not args.print:
            (data_dir / f'{entry["term"]}-calendar.json').write_text(
                json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
