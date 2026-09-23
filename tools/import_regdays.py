#!/usr/bin/env python3
"""
Course registration days: which programme may register for which course on day 1, 2 or 3.

Sabancı publishes this as a PDF (and sometimes an HTML table) before every registration
period: "Course / Days Registration Allowed / 1st Day / 2nd Day / 3rd Day", with the
programmes listed per day, `*` for critical courses and `( ! )` for courses that carry a
class restriction on every day.

  python tools/import_regdays.py CourseRegistrationDays.pdf --term 202601
  python tools/import_regdays.py table.html --term 202601
  python tools/import_regdays.py CourseRegistrationDays.pdf --term 202601 --print

Writes data/<term>-regdays.json, which the timetable uses to tell you which day each of
your courses opens on. The PDF is read with pypdf's layout mode, so the three day columns
stay separate and wrapped programme lists are stitched back together.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COURSE_RE = re.compile(r"^([A-Z]{2,6})\s?(\d{3,5}[A-Z]?)\s*(.*)$")
HEADERS = ("1st Day", "2nd Day", "3rd Day")


def clean(text: str) -> str:
    return " ".join(str(text or "").split())


def programmes(cell: str) -> list[str] | str:
    """'EE- MAT- IE (MS)' -> ['EE', 'MAT', 'IE (MS)']; 'ALL' stays as a marker."""
    text = clean(cell)
    if not text:
        return []
    if text.upper() == "ALL":
        return "ALL"
    parts = [clean(p) for p in text.split("-")]
    return [p for p in parts if p and p.upper() != "CLICK"]


def rows_from_pdf(path: Path) -> list[tuple[str, list[str]]]:
    from pypdf import PdfReader

    rows: list[tuple[str, list[str]]] = []
    for page in PdfReader(str(path)).pages:
        lines = page.extract_text(extraction_mode="layout").split("\n")
        cuts = None
        for line in lines:
            if all(h in line for h in HEADERS):
                cuts = [line.index(h) for h in HEADERS]
                continue
            if cuts is None or not line.strip():
                continue
            # the header's column positions can sit a character or two off the data, so slide
            # every cut left to the start of the word it would otherwise split
            def boundary(at: int) -> int:
                at = min(at, len(line))
                while at > 0 and at < len(line) and line[at - 1] != " ":
                    at -= 1
                return at

            first, second, third = (boundary(c) for c in cuts)
            cells = [line[:first], line[first:second], line[second:third], line[third:]]
            head = clean(cells[0])
            if head.startswith(("*Date of Issue", "(*)", "( ! )", "Course", "*Please")):
                continue
            if head:
                rows.append((head, [clean(c) for c in cells[1:]]))
            elif rows:                       # a wrapped cell continues the row above
                previous, previous_cells = rows[-1]
                rows[-1] = (previous, [clean(f"{a} {b}") for a, b in zip(previous_cells, [clean(c) for c in cells[1:]])])
    return rows


def rows_from_html(path: Path) -> list[tuple[str, list[str]]]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")
    rows = []
    for tr in soup.find_all("tr"):
        cells = [clean(td.get_text(" ")) for td in tr.find_all(["td", "th"])]
        if len(cells) < 4 or not COURSE_RE.match(cells[0]):
            continue
        rows.append((cells[0], cells[1:4]))
    return rows


def build(rows: list[tuple[str, list[str]]], term: str, issued: str | None) -> dict:
    courses: dict[str, dict] = {}
    names: set[str] = set()
    for head, cells in rows:
        m = COURSE_RE.match(head)
        if not m:
            continue
        code = f"{m.group(1)} {m.group(2)}"
        flags = m.group(3) or ""
        # a wrapped row can drag the third column's "ALL" into an earlier cell
        cells = list(cells)
        for i in (0, 1):
            if re.search(r"\bALL\b", cells[i]):
                cells[i] = clean(re.sub(r"\bALL\b", " ", cells[i]))
                cells[2] = clean(f"{cells[2]} ALL")
        days = {}
        for i, cell in enumerate(cells, start=1):
            value = programmes(cell)
            if value:
                days[str(i)] = value
            if isinstance(value, list):
                names.update(value)
        entry = {"days": days}
        if "*" in flags or "*" in m.group(2):
            entry["critical"] = True
        if "!" in flags:
            entry["restricted"] = True
        courses[code] = entry

    return {
        "schema": 1,
        "term": term,
        "issued": issued,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "programs": sorted(names),
        "notes": [
            "Critical courses (*) have no senior class restriction on the first day; senior standing needs 94 SU credits.",
            "Courses marked ( ! ) carry a class restriction on every day — check the course catalog.",
            "On day one, seniors registered in a diploma programme may take their programme's required and core courses.",
        ],
        "courses": courses,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="the registration days PDF or HTML")
    ap.add_argument("--term", required=True, help="term code, e.g. 202601")
    ap.add_argument("--issued", help="date printed on the list, e.g. 21.09.2026")
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--print", action="store_true", help="show what was parsed, write nothing")
    args = ap.parse_args(argv)

    path = Path(args.file)
    rows = rows_from_html(path) if path.suffix.lower() in (".html", ".htm") else rows_from_pdf(path)
    if not rows:
        print("no course rows found in that file", file=sys.stderr)
        return 1

    issued = args.issued
    if not issued and path.suffix.lower() == ".pdf":
        from pypdf import PdfReader
        first = PdfReader(str(path)).pages[0].extract_text() or ""
        found = re.search(r"Date of Issue:\s*([\d.]+)", first)
        issued = found.group(1) if found else None

    data = build(rows, args.term, issued)
    print(f'{len(data["courses"])} courses, {len(data["programs"])} programmes'
          f'{", issued " + issued if issued else ""}')
    if args.print:
        sample = dict(list(data["courses"].items())[:5])
        print(json.dumps({"programs": data["programs"], "sample": sample}, ensure_ascii=False, indent=1))
        return 0

    out = Path(args.data) / f"{args.term}-regdays.json"
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
