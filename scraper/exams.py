#!/usr/bin/env python3
"""
Final exam schedule for SUMods.

Source: https://suis.sabanciuniv.edu/HbbmInst/P_FINAL_EXAM_SCHEDULE.p_print_shedule
It is a printable listing, so the parser reads whatever table it finds: it maps columns
by their headers when they exist (English or Turkish) and otherwise recognises rows by
shape — a course code, a date, a time range, a room.

  python scraper/exams.py                       # newest term in data/terms.json
  python scraper/exams.py --term 202601
  python scraper/exams.py --dump exams.html     # save the page…
  python scraper/exams.py --html exams.html     # …and see what the parser makes of it

Writes data/<term>-exams.json. If the page's shape doesn't match, --dump plus --html
shows exactly what came back; the column keywords live in COLUMNS below.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import clean, make_session  # noqa: E402

EXAMS_URL = "https://suis.sabanciuniv.edu/HbbmInst/P_FINAL_EXAM_SCHEDULE.p_print_shedule"

COLUMNS = {
    "code": ("course", "course code", "ders", "ders kodu", "code", "subject"),
    "section": ("section", "sec", "grup", "şube", "sube", "section no"),
    "crn": ("crn", "crn no"),
    "date": ("date", "exam date", "tarih", "sınav tarihi", "sinav tarihi", "gün", "gun"),
    "time": ("time", "exam time", "saat", "sınav saati", "sinav saati", "hour"),
    "place": ("place", "room", "location", "where", "yer", "derslik", "salon", "building"),
    "instructor": ("instructor", "öğretim üyesi", "ogretim uyesi", "hoca"),
}
CODE_RE = re.compile(r"^([A-Z]{2,6})\s?(\d{3}[A-Z]?)$")
CODE_IN_TEXT_RE = re.compile(r"\b([A-Z]{2,6})\s?(\d{3}[A-Z]?)\b")
CRN_RE = re.compile(r"^\d{5}$")
TIME_RE = re.compile(r"(\d{1,2})[:.](\d{2})")
MONTHS_EN = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
MONTHS_TR = {"oca": 1, "şub": 2, "sub": 2, "mar": 3, "nis": 4, "may": 5, "haz": 6,
             "tem": 7, "ağu": 8, "agu": 8, "eyl": 9, "eki": 10, "kas": 11, "ara": 12}


def parse_date(text: str, default_year: int | None = None) -> str | None:
    t = clean(text)
    if not t:
        return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b", t)            # 08.01.2027
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        year += 2000 if year < 100 else 0
        try:
            return dt.date(year, month, day).isoformat()
        except ValueError:
            return None
    m = re.search(r"\b(\d{1,2})[-\s]([A-Za-zÇĞİÖŞÜçğıöşü]{3,9})\.?[-\s](\d{4})\b", t)   # 08 Oca 2027 / 08-JAN-2027
    if m:
        month = MONTHS_EN.get(m.group(2)[:3].lower()) or MONTHS_TR.get(m.group(2)[:3].lower())
        if month:
            try:
                return dt.date(int(m.group(3)), month, int(m.group(1))).isoformat()
            except ValueError:
                return None
    m = re.search(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b", t)        # Jan 08, 2027
    if m and MONTHS_EN.get(m.group(1)[:3].lower()):
        try:
            return dt.date(int(m.group(3)), MONTHS_EN[m.group(1)[:3].lower()], int(m.group(2))).isoformat()
        except ValueError:
            return None
    m = re.search(r"\b(\d{1,2})[./-](\d{1,2})\b", t)                            # 08.01, year from the term
    if m and default_year:
        try:
            return dt.date(default_year, int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            return None
    return None


def parse_times(text: str) -> tuple[int | None, int | None]:
    found = [int(h) * 60 + int(m) for h, m in TIME_RE.findall(clean(text))]
    if not found:
        return None, None
    if len(found) == 1:
        return found[0], found[0] + 120          # a listed start with no end: finals run two hours
    return found[0], found[-1]


def header_map(cells: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i, cell in enumerate(cells):
        low = clean(cell).lower().strip(" .:*")
        for key, words in COLUMNS.items():
            if key not in out and low in words:
                out[key] = i
    return out


def row_by_shape(cells: list[str], year: int | None) -> dict | None:
    """No usable header: find the course code, date, time and room by what they look like."""
    code = section = crn = date = place = None
    times = (None, None)
    for cell in cells:
        text = clean(cell)
        if not text:
            continue
        if not code:
            m = CODE_RE.match(text) or CODE_IN_TEXT_RE.search(text)
            if m:
                code = f"{m.group(1)} {m.group(2)}"
                rest = text[m.end():].strip(" -–")
                if rest and len(rest) <= 4 and not date:
                    section = rest
                continue
        if not crn and CRN_RE.match(text):
            crn = text
            continue
        if not date:
            found = parse_date(text, year)
            if found:
                date = found
                continue
        if times == (None, None) and TIME_RE.search(text):
            times = parse_times(text)
            continue
        if not section and len(text) <= 4 and re.fullmatch(r"[A-Za-z0-9]{1,4}", text):
            section = text
            continue
        if not place and len(text) <= 60:
            place = text
    if not code or not date:
        return None
    return {"code": code, "section": section or "", "crn": crn, "date": date,
            "start": times[0], "end": times[1], "place": place or ""}


def parse_exams(html: str, year: int | None = None) -> list[dict]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    exams: list[dict] = []
    for table in soup.find_all("table"):
        columns: dict[str, int] = {}
        for row in table.find_all("tr"):
            cells = [clean(c.get_text(" ")) for c in row.find_all(["th", "td"])]
            if not cells:
                continue
            found = header_map(cells)
            if "date" in found and ("code" in found or "crn" in found):
                columns = found
                continue
            if columns:
                def cell(key):
                    i = columns.get(key)
                    return cells[i] if i is not None and i < len(cells) else ""

                code_text = cell("code")
                m = CODE_RE.match(clean(code_text)) or CODE_IN_TEXT_RE.search(code_text)
                date = parse_date(cell("date"), year)
                if not m or not date:
                    continue
                start, end = parse_times(cell("time"))
                exams.append({
                    "code": f"{m.group(1)} {m.group(2)}",
                    "section": clean(cell("section")),
                    "crn": clean(cell("crn")) or None,
                    "date": date, "start": start, "end": end,
                    "place": clean(cell("place")),
                    "instructor": clean(cell("instructor")) or None,
                })
            else:
                guess = row_by_shape(cells, year)
                if guess:
                    exams.append(guess)
    seen = set()
    unique = []
    for exam in exams:
        key = (exam["code"], exam["section"], exam["date"], exam["start"], exam.get("place"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(exam)
    return unique


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", help="term code; defaults to the newest in data/terms.json")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--html", help="parse a saved page instead of fetching")
    ap.add_argument("--dump", help="save the fetched page here")
    ap.add_argument("--print", action="store_true", help="show what was parsed, write nothing")
    args = ap.parse_args(argv)

    data_dir = Path(args.data)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    term = args.term or index["terms"][0]["code"]
    year = int(term[:4]) + (1 if term[4:] != "01" else 0)   # finals of a fall term fall in January

    if args.html:
        html = Path(args.html).read_text(encoding="utf-8", errors="replace")
    else:
        session = make_session()
        res = session.get(EXAMS_URL, timeout=90)
        res.raise_for_status()
        res.encoding = res.apparent_encoding or res.encoding
        html = res.text
        if args.dump:
            Path(args.dump).write_text(html, encoding="utf-8")
            print(f"saved {args.dump}")

    exams = parse_exams(html, year)
    print(f"{len(exams)} exam rows parsed")
    for exam in exams[:5]:
        print("   ", exam)
    if not exams:
        # BannerWeb keeps this page live all year but only fills it in a few weeks before
        # finals, so an empty page is the normal state for most of the term, not a failure.
        # Only treat it as suspicious once the exam period (from the academic calendar, if
        # we have it) has actually started and there's still nothing.
        exams_start = None
        cal_path = data_dir / f"{term}-calendar.json"
        if cal_path.exists():
            exams_start = json.loads(cal_path.read_text(encoding="utf-8")).get("examsStart")
        today = dt.date.today().isoformat()
        if exams_start and today >= exams_start:
            print(f"nothing recognised, but finals should be running since {exams_start} — "
                  f"save the page with --dump and inspect it with --html", file=sys.stderr)
            return 1
        print(f"nothing published yet{f' (finals start {exams_start})' if exams_start else ''} — this is normal until closer to exam period", file=sys.stderr)
        return 0
    if args.print:
        return 0

    out = {"schema": 1, "term": term, "source": EXAMS_URL,
           "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "exams": exams}
    path = data_dir / f"{term}-exams.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{path}: {len(exams)} exams")
    return 0


if __name__ == "__main__":
    sys.exit(main())
