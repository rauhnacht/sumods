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
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
    "engineering": ["engineering", "engineering credit", "engineering credits", "engineering ects",
                    "mühendislik", "mühendislik kredisi"],
    "basicscience": ["basic science", "basic sciences", "basic science credit", "basic science credits",
                     "basic science ects", "temel bilim", "temel bilimler"],
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
    m = re.search(r"(\d+(?:[.,]\d+)?)", "" if text is None else str(text))   # 0 is a real value
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

    for table in soup.find_all("table"):
        rows = [[clean(c.get_text(" ")) for c in r.find_all(["th", "td"])] for r in table.find_all("tr")]
        for head, values in zip(rows, rows[1:]):
            keys = [norm_label(h) for h in head]
            if sum(1 for k in keys if k) >= 2 and len(values) == len(head):
                for key, value in zip(keys, values):
                    if key in ("ects", "credits", "engineering", "basicscience") and number_or_none(value) is not None:
                        put(key, value)
    for row in soup.find_all("tr"):
        cells = row.find_all(["th", "td"])
        # a row whose second cell is itself a label is a column header, not "label | value"
        if len(cells) >= 2 and not norm_label(cells[1].get_text(" ")):
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
    if "Sign in to your account" in res.text[:5000] or "login.microsoftonline" in res.text[:5000]:
        print(f"    login page instead of content (needs a university account): {url}", file=sys.stderr)
        return None
    return res.text


INFO_VERSION = 3          # 3 = Engineering / Basic Science ECTS from BannerWeb's course catalog

# BannerWeb's own course catalog: public (same /prod/ system as the schedule) and, per the EE
# department's own pages, where each course's Engineering and Basic Science ECTS are listed.
# The syllabus pages at apps.sabanciuniv.edu need a university login, so they're linked, not read.
BANNER_CATALOG = ("https://suis.sabanciuniv.edu/prod/bwckctlg.p_disp_course_detail"
                  "?cat_term_in={term}&subj_code_in={subj}&crse_numb_in={num}")
NUM = r"(\d+(?:[.,]\d+)?)"
SPLIT_PATTERNS = {
    # the real page: "Lang. of Instruction: English, 6 ECTS (ENGINEERING:6 / BASIC:0)"
    "engineering": [re.compile(r"\bENGINEERING\s*:\s*" + NUM, re.I),
                    re.compile(NUM + r"\s+(?:ECTS\s+)?Engineering\b", re.I),
                    re.compile(r"^\s*Engineering(?:\s+(?:Credits?|ECTS))*\s*(?:\(ECTS\))?\s*[:\-]?\s*" + NUM, re.I)],
    "basicscience": [re.compile(r"\bBASIC(?:\s+SCIENCES?)?\s*:\s*" + NUM, re.I),
                     re.compile(NUM + r"\s+(?:ECTS\s+)?Basic\s+Sciences?\b", re.I),
                     re.compile(r"^\s*Basic\s+Sciences?(?:\s+(?:Credits?|ECTS))*\s*(?:\(ECTS\))?\s*[:\-]?\s*" + NUM, re.I)],
    "ects": [re.compile(NUM + r"\s+ECTS\b(?!\s+(?:Engineering|Basic))", re.I),
             re.compile(r"^\s*ECTS(?:\s+Credits?)?\s*[:\-]?\s*" + NUM, re.I)],
    "credits": [re.compile(NUM + r"\s+Credit hours\b", re.I)],
}


def parse_banner_catalog(html: str) -> dict:
    """A bwckctlg course detail page: English description, SU credits, ECTS with its
    Engineering / Basic Science split, prerequisites and corequisites — all from the registration
    system itself. Lines are read one at a time so a phrase like "Faculty of Engineering and
    Natural Sciences" can't pass for a credit value."""
    soup = soup_of(html)
    cell = soup.find("td", class_="ntdefault")
    out: dict = {}
    for line in text_lines(cell if cell is not None else soup):
        for key, patterns in SPLIT_PATTERNS.items():
            if key in out:
                continue
            for pattern in patterns:
                m = pattern.search(line)
                if m:
                    out[key] = number_or_none(m.group(1))
                    break
    if cell is None:
        return out

    # description: the text after the italic English title, up to the bold Turkish title or the credits
    parts = []
    for node in cell.children:
        name = getattr(node, "name", None)
        if name == "i":
            continue
        if name == "b" or (name is None and "Credit hours" in str(node)):
            break
        text = node.get_text(" ") if name else str(node)
        if name == "br" and parts and parts[-1] != "\n":
            parts.append("\n")
        elif text.strip():
            parts.append(text)
    desc = clean(" ".join(p for p in parts if p != "\n"))
    if len(desc) > 20:
        out["desc"] = desc[:MAX_TEXT]

    # prerequisites / corequisites: the text under each label, up to the next label
    labels = cell.find_all("span", class_="fieldlabeltext")
    for label in labels:
        key = norm_label(label.get_text(" "))
        if key not in ("prereq", "coreq"):
            continue
        chunk = []
        for node in label.next_siblings:
            if getattr(node, "name", None) == "span" and "fieldlabeltext" in (node.get("class") or []):
                break
            chunk.append(node.get_text(" ") if getattr(node, "name", None) else str(node))
        text = clean(" ".join(chunk))
        if text:
            out[key] = text[:MAX_TEXT]
    return out


def merge_all_info(data_dir: Path) -> Path:
    """data/info-all.json: every course's details from every term's info file, newest term
    winning. Prerequisites and ECTS barely change between terms, so a course looked up in a
    term that was never scraped (or one where it isn't offered) still gets its details."""
    merged: dict[str, dict] = {}
    for path in sorted(data_dir.glob("[0-9][0-9][0-9][0-9][0-9][0-9]-info.json")):
        term = path.name[:6]
        for code, info in json.loads(path.read_text(encoding="utf-8")).get("courses", {}).items():
            merged[code] = {**merged.get(code, {}), **{k: v for k, v in info.items() if k != "syllabus"}, "term": term}
    out = data_dir / "info-all.json"
    out.write_text(json.dumps({"schema": 1, "courses": merged}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out


def course_details(session, term: str, course: dict, dump: Path | None = None, source: str = "both") -> dict:
    subj, base = course["code"].split(" ")
    lecture = next((c for c in course["components"] if c["type"] == ""), course["components"][0])
    num = base + (lecture["type"] or "")
    sections = lecture["sections"]
    info: dict = {"syllabus": {s["group"]: syllabus_url(term, subj, num, s["group"]) for s in sections}}
    fields: dict = {}

    html = fetch(session, BANNER_CATALOG.format(term=term, subj=subj, num=num), dump)
    if html:
        for key, value in parse_banner_catalog(html).items():
            if value is not None and value != "":
                fields[key] = value
        if fields.get("desc"):
            info["source"] = "bannerweb"
    if dump:
        return info

    if source == "syllabus" and sections:          # only on request: these pages need a login
        html = fetch(session, syllabus_url(term, subj, num, sections[0]["group"]), dump)
        if html:
            found = parse_labelled(html)
            if found.get("desc"):
                fields.update(found)
                info["source"] = "syllabus"
            else:
                for key in ("ects", "credits", "engineering", "basicscience"):
                    if found.get(key):
                        fields[key] = found[key]

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
    for key, out_key in (("ects", "ects"), ("credits", "credits"), ("engineering", "eng"), ("basicscience", "bs")):
        value = number_or_none(fields.get(key))
        if value is not None:
            info[out_key] = value
    info["v"] = INFO_VERSION
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
    ap.add_argument("--workers", type=int, default=6, help="courses fetched in parallel (default 6)")
    ap.add_argument("--budget", type=float, default=0,
                    help="minutes to spend before saving and stopping (default 0 = no limit)")
    ap.add_argument("--dump", help="save the first page fetched to this file and stop")
    ap.add_argument("--html", help="parse a saved page and print what the parsers find")
    args = ap.parse_args(argv)
    if args.dump:
        args.refresh = True          # a dump is a look at the live page, even for a stored course

    if args.html:
        html = Path(args.html).read_text(encoding="utf-8", errors="replace")
        print(json.dumps({"banner_catalog": parse_banner_catalog(html)}, ensure_ascii=False))
        print(json.dumps({"labelled": parse_labelled(html), "catalog": parse_catalog(html)},
                         ensure_ascii=False, indent=2)[:4000])
        return 0

    data_dir = Path(args.data)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    if args.term:
        terms = [args.term]
    else:
        # the term in session plus any newer one already listed (next term's registration
        # opens while this one runs, and planning needs its prerequisites too)
        active = default_term(index, data_dir)
        terms = sorted({t["code"] for t in index["terms"] if t["code"] >= active
                        and (data_dir / f'{t["code"]}.json').exists()} | {active})
    known = json.loads((data_dir / "info-all.json").read_text(encoding="utf-8")).get("courses", {}) \
        if (data_dir / "info-all.json").exists() else {}
    session = make_session()
    deadline = time.monotonic() + args.budget * 60 if args.budget > 0 else float("inf")

    for term in terms:
        schedule = json.loads((data_dir / f"{term}.json").read_text(encoding="utf-8"))
        out_path = data_dir / f"{term}-info.json"
        store = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() \
            else {"schema": 1, "term": term, "courses": {}}
        store.setdefault("courses", {})

        courses = schedule["courses"]
        if args.only:
            wanted = {c.upper() for c in args.only}
            courses = [c for c in courses if c["code"].upper() in wanted]
        todo, reused = [], 0
        for c in courses:
            have = store["courses"].get(c["code"])
            if not args.refresh and have and have.get("v", 1) >= INFO_VERSION:
                continue
            other = known.get(c["code"])
            if not args.refresh and other and other.get("v", 1) >= INFO_VERSION and other.get("term") != term:
                # already read this term or another — reuse it, only the syllabus links are per-term
                subj, base = c["code"].split(" ")
                lecture = next((x for x in c["components"] if x["type"] == ""), c["components"][0])
                store["courses"][c["code"]] = {
                    **{k: v for k, v in other.items() if k != "term"},
                    "syllabus": {sec["group"]: syllabus_url(term, subj, base + (lecture["type"] or ""), sec["group"])
                                 for sec in lecture["sections"]},
                }
                reused += 1
                continue
            todo.append(c)
        if args.limit:
            todo = todo[: args.limit]
        print(f"{term}: {len(todo)} to fetch, {reused} reused from another term, {len(store['courses'])} stored")

        def flush():
            store["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            out_path.write_text(json.dumps(store, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

        if args.dump:
            if todo:
                print(f"  [1/1] {todo[0]['code']}")
                course_details(session, term, todo[0], Path(args.dump), args.source)
                return 0
            continue

        lock = threading.Lock()
        done = {"n": 0}

        def work(course):
            if time.monotonic() > deadline:
                return
            info = course_details(session, term, course, None, args.source)
            with lock:
                store["courses"][course["code"]] = info
                known[course["code"]] = {**info, "term": term}
                done["n"] += 1
                if done["n"] % 25 == 0:
                    flush()
                    print(f"  {done['n']}/{len(todo)}")
            time.sleep(args.delay)

        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            list(pool.map(work, todo))
        flush()
        if done["n"] < len(todo):
            print(f"  budget reached after {done['n']}/{len(todo)} — the next run picks up the rest")
        described = sum(1 for v in store["courses"].values() if v.get("desc"))
        tagged = sum(1 for v in store["courses"].values() if v.get("eng") or v.get("bs"))
        print(f"{out_path}: {len(store['courses'])} courses, {described} described, "
              f"{tagged} with Engineering/Basic Science credits")

    print(merge_all_info(data_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
