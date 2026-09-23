#!/usr/bin/env python3
"""
Degree requirements for SUMods' planner, per programme and entry term.

Source: the course catalogue's degree detail page, served by BannerWeb
  https://suis.sabanciuniv.edu/HbbmWeb/SU_DEGREE.p_degree_detail?P_TERM=202601&P_PROGRAM=BSEE&P_SUBMIT=&P_LANG=EN&P_LEVEL=UG
(the page on www.sabanciuniv.edu/en/prospective-students/degree-detail embeds this one).

P_TERM is the term a student *entered* the university, because requirements follow the
entry year. Each page has a "Summary of Degree Requirements" (University Courses, Required
Courses, Core Electives, Area Electives, Free Electives… with minimum SU credits / ECTS)
followed by one course list per area. A course appears only under the first area it
belongs to, in summary order.

  python scraper/programs.py                              # every programme, fall+spring entries since 2019
  python scraper/programs.py --programs BSEE BSMAT --entries 202401 202501
  python scraper/programs.py --programs BSEE --entries 202401 --dump bsee.html
  python scraper/programs.py --html bsee.html --programs BSEE --entries 202401 --print

Writes data/programs/<CODE>.json (one file per programme, every entry term inside) and
data/programs/index.json. Identical requirement sets across entry terms are stored once.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import clean, make_session, term_name  # noqa: E402

URL = ("https://suis.sabanciuniv.edu/HbbmWeb/SU_DEGREE.p_degree_detail"
       "?P_TERM={term}&P_PROGRAM={program}&P_SUBMIT=&P_LANG=EN&P_LEVEL=UG")
PROGRAMS = {
    "BSCS": "Computer Science and Engineering",
    "BSEE": "Electronics Engineering",
    "BSMAT": "Materials Science and Nano Engineering",
    "BSMS": "Industrial Engineering",
    "BSBIO": "Molecular Biology, Genetics and Bioengineering",
    "BSDSA": "Data Science and Analytics",
    "BSME": "Mechatronics Engineering",
    "BAECON": "Economics",
    "BAVACD": "Visual Arts and Visual Communication Design",
    "BAPSIR": "Political Science and International Relations",
    "BAPSY": "Psychology",
    "BAMAN": "Management",
}
CODE_RE = re.compile(r"^\s*([A-Z]{2,6})\s?(\d{3,5}[A-Z]?)\b")
NUM_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*$")
KINDS = [
    ("university", ("university course", "university courses", "üniversite dersleri")),
    ("required", ("required course", "required courses", "zorunlu", "required")),
    ("core", ("core elective", "core electives", "çekirdek")),
    ("area", ("area elective", "area electives", "alan seçmeli")),
    ("free", ("free elective", "free electives", "serbest seçmeli")),
    ("faculty", ("faculty course", "faculty courses", "fakülte dersleri")),
    ("philosophy", ("philosophy elective", "philosophy electives")),
    ("total", ("total", "toplam")),
]


def kind_of(name: str) -> str | None:
    low = re.sub(r"[*:()\d]", "", clean(name).lower()).strip()
    for kind, words in KINDS:
        if any(low == w or low.startswith(w) for w in words):
            return kind
    return None


def numbers(cells: list[str]) -> list[float]:
    out = []
    for cell in cells:
        m = NUM_RE.match(cell)
        if m:
            v = float(m.group(1).replace(",", "."))
            out.append(int(v) if v == int(v) else v)
    return out


def parse_page(html: str) -> dict:
    """Summary table plus one course list per area, in document order."""
    from bs4 import BeautifulSoup
    from bs4.element import NavigableString, Tag

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()

    title = ""
    for text in soup.stripped_strings:
        if "program" in text.lower() and ("undergraduate" in text.lower() or "lisans" in text.lower()):
            title = clean(text)
            break

    # ---- summary: rows whose first cell names an area and that carry numbers
    summary: list[dict] = []
    columns: list[str] = []
    in_summary = False
    for tr in soup.find_all("tr"):
        cells = [clean(c.get_text(" ")) for c in tr.find_all(["th", "td"])]
        if not cells:
            continue
        joined = " ".join(cells).lower()
        if "summary of degree requirements" in joined or "özet" in joined:
            in_summary = True
            continue
        if in_summary and not numbers(cells[1:]) and any("credit" in c.lower() or "ects" in c.lower() for c in cells):
            columns = [c.lower() for c in cells]
            continue
        kind = kind_of(cells[0]) if cells else None
        values = numbers(cells[1:])
        if kind and values and (in_summary or len(summary) < 12):
            entry = {"name": cells[0].strip(" *"), "kind": kind}
            if columns:
                for label, value in zip(columns[1:], cells[1:]):
                    n = numbers([value])
                    if not n:
                        continue
                    if "ects" in label:
                        entry["ects"] = n[0]
                    elif "course" in label or "ders" in label:
                        entry["minCourses"] = n[0]
                    elif "credit" in label or "kredi" in label:
                        entry["credits"] = n[0]
            else:
                entry["credits"] = values[0]
                if len(values) > 1:
                    entry["ects"] = values[1]
            if not any(s["name"] == entry["name"] for s in summary):
                summary.append(entry)
        elif in_summary and summary and not kind and not values and len(cells) == 1:
            in_summary = False

    # ---- course lists: walk the document; a heading naming an area opens its list
    groups: dict[str, dict] = {s["name"]: {**s, "courses": []} for s in summary if s["kind"] != "total"}
    by_kind = {s["kind"]: s["name"] for s in summary}
    current = None
    credits: dict[str, list] = {}
    seen_rows = set()

    def open_area(text: str):
        nonlocal current
        kind = kind_of(text)
        if not kind or kind == "total":
            return False
        name = next((n for n in groups if clean(n).lower() == clean(text).strip(" *:").lower()), None)
        if name is None:
            name = by_kind.get(kind)
        if name is None:
            name = clean(text).strip(" *:")
            groups[name] = {"name": name, "kind": kind, "courses": []}
            by_kind.setdefault(kind, name)
        current = name
        return True

    for node in soup.descendants:
        if isinstance(node, Tag) and node.name == "tr":
            if id(node) in seen_rows:
                continue
            seen_rows.add(id(node))
            cells = [clean(c.get_text(" ")) for c in node.find_all(["th", "td"])]
            if not cells:
                continue
            code_cell = next((c for c in cells if CODE_RE.match(c)), None)
            if code_cell and current:
                m = CODE_RE.match(code_cell)
                code = f"{m.group(1)} {m.group(2)}"
                group = groups[current]
                if code not in group["courses"]:
                    group["courses"].append(code)
                values = numbers(cells[cells.index(code_cell) + 1:])
                if values:
                    credits[code] = values[:2]
            elif not code_cell and len([c for c in cells if c]) <= 2 and not numbers(cells[1:]):
                open_area(cells[0])
        elif isinstance(node, NavigableString):
            parent = node.parent
            if parent is not None and parent.find_parent("tr") is None:
                text = clean(str(node))
                if 3 < len(text) < 60:
                    open_area(text)

    ordered = [groups[s["name"]] for s in summary if s["name"] in groups]
    ordered += [g for name, g in groups.items() if all(name != s["name"] for s in summary)]
    for g in ordered:
        if g["kind"] == "free" and not g["courses"]:
            g["any"] = True
    total = next((s for s in summary if s["kind"] == "total"), {})
    return {"title": title, "groups": ordered, "credits": credits,
            "totalCredits": total.get("credits"), "totalEcts": total.get("ects")}


def default_entries(newest: str) -> list[str]:
    year = int(newest[:4])
    out = []
    for y in range(2019, year + 1):
        for part in ("01", "02"):
            code = f"{y}{part}"
            if code <= newest:
                out.append(code)
    return sorted(out, reverse=True)


def digest(entry: dict) -> str:
    return hashlib.sha1(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:12]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--programs", nargs="*", default=list(PROGRAMS), help="programme codes, e.g. BSEE BSMAT")
    ap.add_argument("--entries", nargs="*", help="entry terms (default: fall + spring since 2019)")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--delay", type=float, default=1.0)
    ap.add_argument("--html", help="parse a saved page (with one --programs and one --entries)")
    ap.add_argument("--dump", help="save the first fetched page here and stop")
    ap.add_argument("--print", action="store_true", help="show what was parsed, write nothing")
    args = ap.parse_args(argv)

    data_dir = Path(args.data)
    out_dir = data_dir / "programs"
    index_path = data_dir / "terms.json"
    newest = json.loads(index_path.read_text(encoding="utf-8"))["terms"][0]["code"] if index_path.exists() else "202601"
    entries = args.entries or default_entries(newest)

    if args.html:
        parsed = parse_page(Path(args.html).read_text(encoding="utf-8", errors="replace"))
        print(json.dumps({**parsed, "credits": dict(list(parsed["credits"].items())[:8])},
                         ensure_ascii=False, indent=1)[:5000])
        return 0 if parsed["groups"] else 1

    session = make_session()
    out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for program in args.programs:
        path = out_dir / f"{program}.json"
        store = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
            "program": program, "name": PROGRAMS.get(program, program), "entries": {}}
        hashes = {}
        for entry_term in entries:
            url = URL.format(term=entry_term, program=program)
            print(f"{program} {entry_term}")
            try:
                res = session.get(url, timeout=60)
                res.raise_for_status()
            except Exception as exc:
                print(f"  failed: {exc}", file=sys.stderr)
                continue
            if args.dump:
                Path(args.dump).write_text(res.text, encoding="utf-8")
                print(f"  saved {args.dump}")
                return 0
            parsed = parse_page(res.text)
            if not parsed["groups"]:
                print("  no requirements on that page (programme not open to that entry term?)")
                continue
            entry = {"groups": parsed["groups"], "credits": parsed["credits"],
                     "totalCredits": parsed["totalCredits"], "totalEcts": parsed["totalEcts"], "source": url}
            h = digest({k: v for k, v in entry.items() if k != "source"})
            if h in hashes:
                store["entries"][entry_term] = {"sameAs": hashes[h]}
            else:
                hashes[h] = entry_term
                store["entries"][entry_term] = entry
            if parsed["title"] and store["name"] == program:
                store["name"] = parsed["title"]
            print(f"  {len(parsed['groups'])} areas, {sum(len(g['courses']) for g in parsed['groups'])} courses")
            time.sleep(args.delay)
        store["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if args.print:
            print(json.dumps(store, ensure_ascii=False, indent=1)[:4000])
            continue
        if store["entries"]:
            path.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index.append({"code": program, "name": store["name"],
                      "entries": sorted(store["entries"], reverse=True)})

    if not args.print and index:
        existing = {}
        idx_path = out_dir / "index.json"
        if idx_path.exists():
            existing = {p["code"]: p for p in json.loads(idx_path.read_text(encoding="utf-8")).get("programs", [])}
        existing.update({p["code"]: p for p in index})
        idx_path.write_text(json.dumps({"schema": 1, "programs": sorted(existing.values(), key=lambda p: p["code"])},
                                       ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{idx_path}: {len(existing)} programme(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
