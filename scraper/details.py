#!/usr/bin/env python3
"""
Course details for SUMods: description, objectives, ECTS and prerequisites.

Two sources, in order:

  1. The syllabus a section publishes
     https://apps.sabanciuniv.edu/courses/syllabus/view.php?term=202601&sc=CS&cn=412&section=B&view=su
  2. The public course catalog, which carries the description, SU credits, ECTS
     credit, prerequisite and corequisite
     https://www.sabanciuniv.edu/en/aday-ogrenciler/lisans/ders-katalogu/course/CS-412

Results go to data/<term>-info.json, which the site loads on top of the schedule.
Courses already stored are skipped, so re-running only picks up what's new.

  python scraper/details.py                       # every course in the newest term
  python scraper/details.py --term 202601 --limit 20
  python scraper/details.py --only "CS 412" "EE 311"
  python scraper/details.py --refresh             # re-fetch everything
  python scraper/details.py --only "CS 412" --dump cs412.html   # save the page to inspect
  python scraper/details.py --html cs412.html     # show what the parsers find in it

If a syllabus page can't be read or has no description, the catalog page is used and
the section's syllabus link is still written out for the site to link to.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrape import clean, make_session, active_term_code  # noqa: E402


def default_term(index: dict, data_dir) -> str:
    """The term actually in session now, if we have its schedule; else the newest listed.

    A term can appear in terms.json (sorted by code) before its classes start — next
    Spring shows up while this Fall is still running, and its higher code would otherwise
    look like "the current term" by pure sorting.
    """
    codes = {t["code"] for t in index["terms"]}
    active = active_term_code()
    if active in codes and (data_dir / f"{active}.json").exists():
        return active
    return index["terms"][0]["code"]

SYLLABUS_URL = ("https://apps.sabanciuniv.edu/courses/syllabus/view.php"
                "?term={term}&sc={subj}&cn={num}&section={section}&view=su")
CATALOG_URL = "https://www.sabanciuniv.edu/en/aday-ogrenciler/{level}/ders-katalogu/course/{subj}-{num}"
MAX_TEXT = 1500

# Labels seen on syllabus pages, English and Turkish. Keys are what we store.
FIELDS = {
    "desc": ["course description", "description", "course content", "content",
             "ders tanımı", "ders içeriği", "içerik"],
    "objectives": ["course objectives", "objectives", "objective", "aim", "aims",
                   "amaç", "dersin amacı"],
    "outcomes": ["learning outcomes", "learning outcome", "öğrenme çıktıları", "dersin çıktıları"],
    "textbook": ["textbook", "textbooks", "required textbook", "course material",
                 "course materials", "ders kitabı", "kaynaklar"],
    "assessment": ["assessment", "assessment methods", "evaluation", "grading", "değerlendirme"],
    "prereq": ["prerequisite", "prerequisites", "ön koşul", "önkoşul"],
    "coreq": ["corequisite", "corequisites", "yan koşul"],
    "language": ["language of instruction", "language", "dil"],
    "ects": ["ects credit", "ects credits", "ects", "akts"],
    "credits": ["su credits", "su credit", "credits", "kredi"],
}
LABEL_LOOKUP = {label: key for key, labels in FIELDS.items() for label in labels}
LABEL_RE = re.compile(r"^\s*([A-Za-zÇĞİÖŞÜçğıöşü' /()]{3,40})\s*[::]\s*(.*)$")
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,6})\s?(\d{3}[A-Z]?)\b")
TERM_LINE_RE = re.compile(r"^\*?\s*\d{4}\s+(Fall|Spring|Summer|Güz|Bahar|Yaz)\s*$", re.IGNORECASE)
CREDITS_LINE_RE = re.compile(r"^\**\s*SU\s+Credits?\s*[::]", re.IGNORECASE)
SKIP_LINE_RE = re.compile(r"^(LISTEN|TR\s+EN|Select Term|Dönem|Languages?|Home|Course)\b", re.IGNORECASE)


def soup_of(html: str):
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript"]):
        tag.decompose()
    return soup


def text_lines(soup) -> list[str]:
    return [ln for ln in (clean(x) for x in soup.get_text("\n").split("\n")) if ln]


def norm_label(text: str):
    return LABEL_LOOKUP.get(clean(text).strip(" :：*").lower())


def number_or_none(text):
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(text or ""))
    if not m:
        return None
    value = float(m.group(1).replace(",", "."))
    return int(value) if value == int(value) else value


def parse_labelled(html: str) -> dict:
    """'Label: value' pairs, whether they sit in table rows, definition lists or plain text."""
    soup = soup_of(html)
    out: dict[str, str] = {}

    def put(key, value):
        value = clean(value)
        if key and value and value not in {"-", "--", ":"} and key not in out:
            out[key] = value[:MAX_TEXT]

    for row in soup.find_all("tr"):
        cells = row.find_all(["th", "td"])
        if len(cells) >= 2:
            put(norm_label(cells[0].get_text(" ")), cells[1].get_text(" "))
    for tag in soup.find_all("dt"):
        value = tag.find_next_sibling("dd")
        if value is not None:
            put(norm_label(tag.get_text(" ")), value.get_text(" "))

    current, buffer = None, []
    for line in text_lines(soup):
        m = LABEL_RE.match(line)
        key = norm_label(m.group(1)) if m else norm_label(line)
        if key:
            if current and buffer:
                put(current, " ".join(buffer))
            current, buffer = key, ([m.group(2)] if m and m.group(2) else [])
        elif current and len(" ".join(buffer)) < MAX_TEXT:
            buffer.append(line)
    if current and buffer:
        put(current, " ".join(buffer))
    return out


def parse_catalog(html: str) -> dict:
    """Catalog pages print the description as a bare paragraph above 'SU Credits :'."""
    out = parse_labelled(html)
    lines = text_lines(soup_of(html))
    end = next((i for i, ln in enumerate(lines) if CREDITS_LINE_RE.match(ln)), None)
    if end is None:
        return out
    start = 0
    for i in range(end - 1, -1, -1):
        if TERM_LINE_RE.match(lines[i]) or SKIP_LINE_RE.match(lines[i]):
            start = i + 1
            break
    body = [ln for ln in lines[start:end] if not TERM_LINE_RE.match(ln) and not SKIP_LINE_RE.match(ln)]
    desc = clean(" ".join(body))
    if len(desc) > 20:
        out["desc"] = desc[:MAX_TEXT]
    return out


def parse_requirements(text: str) -> list[list[str]]:
    """'CS 300 MIN Grade D and (MATH 201 or MATH 204)' -> [['CS 300'], ['MATH 201', 'MATH 204']].

    Groups are ANDed, the codes inside a group are alternatives.
    """
    if not text or text.strip(" -.") == "":
        return []
    groups: list[list[str]] = []
    for chunk in re.split(r"\s*(?:\band\b|\bve\b|,|;|\+)\s*", text, flags=re.IGNORECASE):
        alternatives: list[str] = []
        for part in re.split(r"\s*(?:\bor\b|\bveya\b|/)\s*", chunk, flags=re.IGNORECASE):
            found = COURSE_CODE_RE.search(part)
            if found:
                code = f"{found.group(1)} {found.group(2)}"
                if code not in alternatives:
                    alternatives.append(code)
        if alternatives:
            groups.append(alternatives)
    return groups


def syllabus_url(term: str, subj: str, num: str, section: str) -> str:
    return SYLLABUS_URL.format(term=term, subj=subj, num=num, section=section)


def catalog_url(subj: str, num: str, graduate: bool) -> str:
    return CATALOG_URL.format(level="lisansustu" if graduate else "lisans", subj=subj, num=num)


def is_graduate(num: str) -> bool:
    return num[:1] >= "5"


def fetch(session, url: str, dump: Path | None = None):
    try:
        res = session.get(url, timeout=45, headers={"Referer": "https://www.sabanciuniv.edu/"})
    except Exception as exc:
        print(f"    failed {url}: {exc}", file=sys.stderr)
        return None
    if res.status_code != 200:
        print(f"    {res.status_code} {url}", file=sys.stderr)
        return None
    if dump:
        dump.write_text(res.text, encoding="utf-8")
        print(f"    saved {dump}")
    return res.text


def course_details(session, term: str, course: dict, dump: Path | None = None, source: str = "both") -> dict:
    subj, base = course["code"].split(" ")
    lecture = next((c for c in course["components"] if c["type"] == ""), course["components"][0])
    num = base + (lecture["type"] or "")
    sections = lecture["sections"]
    info: dict = {"syllabus": {s["group"]: syllabus_url(term, subj, num, s["group"]) for s in sections}}
    fields: dict = {}

    if source in ("both", "syllabus") and sections:
        html = fetch(session, syllabus_url(term, subj, num, sections[0]["group"]), dump)
        if html:
            found = parse_labelled(html)
            if found.get("desc"):
                fields.update(found)
                info["source"] = "syllabus"

    if source in ("both", "catalog") and (not fields.get("desc") or not fields.get("ects")):
        for graduate in (is_graduate(base), not is_graduate(base)):
            html = fetch(session, catalog_url(subj, base, graduate), dump)
            if not html:
                continue
            found = parse_catalog(html)
            if found.get("desc") or found.get("ects"):
                for key, value in found.items():
                    fields.setdefault(key, value)
                info.setdefault("source", "catalog")
                break

    for key in ("desc", "objectives", "outcomes", "textbook", "assessment", "language", "prereq", "coreq"):
        value = fields.get(key)
        if value and value.strip(" -."):
            info[key] = value
    for key in ("ects", "credits"):
        value = number_or_none(fields.get(key))
        if value is not None:
            info[key] = value
    for key, out_key in (("prereq", "prereqCodes"), ("coreq", "coreqCodes")):
        groups = parse_requirements(info.get(key, ""))
        if groups:
            info[out_key] = groups
    info["url"] = catalog_url(subj, base, is_graduate(base))
    return info


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--term", help="term code; defaults to the newest in data/terms.json")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--only", nargs="*", help="course codes to fetch, e.g. 'CS 412'")
    ap.add_argument("--limit", type=int, help="stop after N courses")
    ap.add_argument("--refresh", action="store_true", help="re-fetch courses already stored")
    ap.add_argument("--source", choices=["both", "syllabus", "catalog"], default="both")
    ap.add_argument("--delay", type=float, default=0.8, help="seconds between courses (default 0.8)")
    ap.add_argument("--dump", help="save the first page fetched to this file and stop")
    ap.add_argument("--html", help="parse a saved page and print what the parsers find")
    args = ap.parse_args(argv)

    if args.html:
        html = Path(args.html).read_text(encoding="utf-8", errors="replace")
        print(json.dumps({"labelled": parse_labelled(html), "catalog": parse_catalog(html)},
                         ensure_ascii=False, indent=2)[:4000])
        return 0

    data_dir = Path(args.data)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    term = args.term or default_term(index, data_dir)
    schedule = json.loads((data_dir / f"{term}.json").read_text(encoding="utf-8"))

    out_path = data_dir / f"{term}-info.json"
    store = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() \
        else {"schema": 1, "term": term, "courses": {}}
    store.setdefault("courses", {})

    courses = schedule["courses"]
    if args.only:
        wanted = {c.upper() for c in args.only}
        courses = [c for c in courses if c["code"].upper() in wanted]
    todo = [c for c in courses if args.refresh or c["code"] not in store["courses"]]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{term}: {len(todo)} course(s) to fetch, {len(store['courses'])} already stored")

    def flush():
        store["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out_path.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    session = make_session()
    for i, course in enumerate(todo, 1):
        print(f"  [{i}/{len(todo)}] {course['code']}")
        info = course_details(session, term, course, Path(args.dump) if args.dump else None, args.source)
        if args.dump:
            return 0
        store["courses"][course["code"]] = info
        if i % 25 == 0:
            flush()
        time.sleep(args.delay)

    flush()
    described = sum(1 for v in store["courses"].values() if v.get("desc"))
    print(f"{out_path}: {len(store['courses'])} courses, {described} with a description")
    return 0


if __name__ == "__main__":
    sys.exit(main())
