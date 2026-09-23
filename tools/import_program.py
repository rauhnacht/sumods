#!/usr/bin/env python3
"""
Turn a curriculum listing into a SUMods programme, so the planner can track requirements.

Input is a CSV/TSV (or an HTML table saved from wherever the curriculum lives) with a row
per course:

    group,code,credits,year,term
    University courses,SPS 101,3,1,fall
    University courses,HIST 191,2,1,fall
    Engineering core,EE 202,4,2,spring
    Area electives,,21,,            # no code: a credit requirement for the whole group
    Free electives,,12,,any         # 'any' in the term column: any course counts

Header names are matched loosely (group/category/alan, code/ders/course, credits/kredi,
year/yıl, term/semester/dönem), and the columns may be in any order. `year` + `term` are
optional; when present they become the suggested year-by-year plan the planner can fill in.

  python tools/import_program.py ee.csv --id EE-BS-2026 --name "Electronics Engineering (BSc)"
  python tools/import_program.py curriculum.html --html --id MAT-BS-2026 --name "Materials Science"
  python tools/import_program.py ee.csv --id EE-BS-2026 --name "EE" --print

Writes into data/programs.json, replacing any programme with the same id.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = {
    "group": ("group", "category", "requirement", "type", "grup", "kategori", "alan"),
    "code": ("code", "course", "course code", "ders", "ders kodu", "kod"),
    "credits": ("credits", "credit", "su credits", "kredi", "su kredi"),
    "ects": ("ects", "akts", "ects credit"),
    "year": ("year", "yıl", "yil", "sınıf", "sinif"),
    "term": ("term", "semester", "dönem", "donem", "yarıyıl", "yariyil"),
}
CODE_RE = re.compile(r"^([A-Z]{2,6})\s?(\d{3}[A-Z]?)$")
PART = {"fall": "F", "güz": "F", "guz": "F", "1": "F", "spring": "S", "bahar": "S", "2": "S",
        "summer": "U", "yaz": "U", "3": "U"}


def norm(text: str) -> str:
    return " ".join(str(text or "").split())


def field_of(header: str) -> str | None:
    low = norm(header).lower().strip(":*")
    for key, names in FIELDS.items():
        if low in names:
            return key
    return None


def rows_from_csv(text: str) -> list[dict]:
    sample = text[:2000]
    delimiter = "\t" if sample.count("\t") > sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    raw = [row for row in reader if any(norm(c) for c in row)]
    if not raw:
        return []
    columns = {i: field_of(cell) for i, cell in enumerate(raw[0])}
    if not any(columns.values()):                     # no header: assume the documented order
        columns = dict(enumerate(["group", "code", "credits", "year", "term"]))
        body = raw
    else:
        body = raw[1:]
    out = []
    for row in body:
        item = {}
        for i, cell in enumerate(row):
            key = columns.get(i)
            if key:
                item[key] = norm(cell)
        if item:
            out.append(item)
    return out


def rows_from_html(html: str, table_index: int = 0) -> list[dict]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    tables = soup.find_all("table")
    if not tables:
        return []
    table = tables[min(table_index, len(tables) - 1)]
    rows = [[norm(c.get_text(" ")) for c in tr.find_all(["th", "td"])] for tr in table.find_all("tr")]
    rows = [r for r in rows if any(r)]
    text = "\n".join(",".join(f'"{c}"' for c in row) for row in rows)
    return rows_from_csv(text)


def number(value):
    m = re.search(r"\d+(?:[.,]\d+)?", str(value or ""))
    if not m:
        return None
    n = float(m.group(0).replace(",", "."))
    return int(n) if n == int(n) else n


def build(rows: list[dict], program_id: str, name: str, catalog: str | None) -> dict:
    groups: dict[str, dict] = {}
    order: list[str] = []
    suggested: dict[str, list[str]] = {}

    for row in rows:
        group_name = row.get("group") or "Required"
        if group_name not in groups:
            groups[group_name] = {"name": group_name, "courses": []}
            order.append(group_name)
        group = groups[group_name]
        code_text = norm(row.get("code", "")).upper().replace("  ", " ")
        match = CODE_RE.match(code_text)
        credits = number(row.get("credits"))

        if not match:
            # a row without a course code states the group's own requirement
            if credits:
                group["credits"] = credits
            if norm(row.get("term", "")).lower() in ("any", "free", "serbest"):
                group["any"] = True
            if code_text and "*" in code_text or code_text.count("X") >= 2:
                group["match"] = (code_text.replace("XXX", r"\d{3}").replace("XX", r"\d{2}")
                                  .replace("*", r"\d").replace("  ", " "))
            continue

        code = f"{match.group(1)} {match.group(2)}"
        if code not in group["courses"]:
            group["courses"].append(code)
        if credits:
            group.setdefault("creditsEach", credits)
        year, term = number(row.get("year")), norm(row.get("term", "")).lower()
        part = PART.get(term) or PART.get(term[:1]) if term else None
        if year and part:
            suggested.setdefault(f"{int(year)}{part}", []).append(code)

    program = {"id": program_id, "name": name, "groups": [groups[g] for g in order]}
    if catalog:
        program["catalog"] = catalog
    total = sum(g.get("credits") or 0 for g in program["groups"])
    if total:
        program["totalCredits"] = total
    if suggested:
        program["suggested"] = suggested
    return program


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="CSV/TSV file, or HTML with --html")
    ap.add_argument("--id", required=True, help="short id, e.g. EE-BS-2026")
    ap.add_argument("--name", required=True, help="programme name shown in the planner")
    ap.add_argument("--catalog", help="catalogue year, e.g. 2026")
    ap.add_argument("--html", action="store_true", help="read a table out of an HTML page")
    ap.add_argument("--table-index", type=int, default=0)
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--print", action="store_true", help="show the programme, write nothing")
    args = ap.parse_args(argv)

    text = Path(args.file).read_text(encoding="utf-8", errors="replace")
    rows = rows_from_html(text, args.table_index) if args.html else rows_from_csv(text)
    if not rows:
        print("no rows found in that file", file=sys.stderr)
        return 1
    program = build(rows, args.id, args.name, args.catalog)
    courses = sum(len(g["courses"]) for g in program["groups"])
    print(f'{program["name"]}: {len(program["groups"])} groups, {courses} courses'
          f'{", suggested plan for " + str(len(program.get("suggested", {}))) + " semesters" if program.get("suggested") else ""}')
    if args.print:
        print(json.dumps(program, ensure_ascii=False, indent=1))
        return 0

    path = Path(args.data) / "programs.json"
    store = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema": 1, "programs": []}
    store["programs"] = [p for p in store.get("programs", []) if p.get("id") != program["id"]] + [program]
    store["programs"].sort(key=lambda p: p["name"])
    path.write_text(json.dumps(store, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{path}: {len(store['programs'])} programme(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
