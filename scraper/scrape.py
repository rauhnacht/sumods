#!/usr/bin/env python3
"""
SUMods scraper: reads Sabancı University's public BannerWeb class schedule
(bwckschd.p_disp_dyn_sched) and writes the JSON files the SUMods site loads:

  data/terms.json      index of available terms
  data/<term>.json     every course, section, meeting time, room and instructor

Usage:
  python scraper/scrape.py                    # latest 3 terms listed in BannerWeb
  python scraper/scrape.py --latest 2
  python scraper/scrape.py --terms 202601 202502
  python scraper/scrape.py --html saved.html --terms 202601   # parse a saved page

Needs: requests, beautifulsoup4 (see requirements.txt).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

BASE = "https://suis.sabanciuniv.edu/prod"
TERMS_URL = f"{BASE}/bwckschd.p_disp_dyn_sched"
SUBJECTS_URL = f"{BASE}/bwckgens.p_proc_term_date"
SCHEDULE_URL = f"{BASE}/bwckschd.p_get_crse_unsec"
USER_AGENT = "Mozilla/5.0 (compatible; SUMods/1.0; course timetable planner)"

SCHEMA = 1
DAY_LETTERS = "MTWRFSU"
TYPE_LABELS = {"": "Lecture", "R": "Recitation", "L": "Lab", "D": "Discussion"}
BUILDINGS = [
    (r"Fac\.\s*of\s*Engin\.\s*and\s*Nat\.\s*Sci\.", "FENS"),
    (r"Fac\.\s*of\s*Arts\s*and\s*Social\s*Sci\.", "FASS"),
    (r"Sabanc[ıi]\s*Business\s*School", "FMAN"),
    (r"School\s*of\s*Languages\s*Building", "SL"),
    (r"University\s*Center", "UC"),
]
TITLE_RE = re.compile(
    r"^(?P<title>.+?) - (?P<crn>\d{4,6}) - (?P<subj>[A-Z]{1,6}) (?P<num>[0-9A-Z]+) - (?P<group>[0-9A-Za-z]+)$"
)
COMPONENT_WORDS = re.compile(
    r"[\s,:\-]*\b(Recitation|Rec\.|Laboratory|Lab\.?|Discussion|Disc\.|Problem Session|Studio)\s*$",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------- helpers

def clean(text: str) -> str:
    return " ".join((text or "").split())


def term_name(code: str) -> str:
    year, part = int(code[:4]), code[4:]
    season = {"01": "Fall", "02": "Spring", "03": "Summer"}.get(part, f"Term {part}")
    return f"{season} {year}-{year + 1}"


def current_terms(n: int, today: dt.date | None = None) -> list[str]:
    """Fallback when the term list can't be read: derive codes from the date.

    Starts one term ahead of today, because registration for the next term opens while the
    current one is still running — that upcoming term is usually the one worth planning.
    """
    today = today or dt.date.today()
    y, m = today.year, today.month
    year, part = (y, 1) if m >= 8 else (y - 1, 2) if m <= 4 else (y - 1, 3)
    part += 1                      # look ahead one term
    if part > 3:
        year, part = year + 1, 1
    out = []
    for _ in range(n):
        out.append(f"{year}{part:02d}")
        part -= 1
        if part == 0:
            year, part = year - 1, 3
    return out


def parse_minutes(text: str) -> int | None:
    m = re.match(r"^\s*(\d{1,2})[:.](\d{2})\s*([ap])\.?m\.?\s*$", text, re.IGNORECASE)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3).lower()
    if h == 12:
        h = 0
    if ap == "p":
        h += 12
    return h * 60 + mi


def parse_time_range(text: str) -> tuple[int | None, int | None]:
    parts = re.split(r"\s+-\s+", clean(text))
    if len(parts) != 2:
        return None, None
    return parse_minutes(parts[0]), parse_minutes(parts[1])


def parse_days(text: str) -> list[int]:
    t = clean(text).upper()
    if not t or t == "TBA" or not re.fullmatch(r"[MTWRFSU]+", t):
        return []
    return [DAY_LETTERS.index(ch) for ch in t]


def short_place(text: str) -> str:
    t = clean(text)
    if t.upper() in ("TBA", "TBD", "-"):
        return ""
    for pattern, abbr in BUILDINGS:
        t = re.sub(pattern, abbr, t)
    return clean(t)


def parse_instructors(text: str) -> list[str]:
    t = re.sub(r"\(\s*P\s*\)", "", text or "")
    names = [clean(n) for n in t.split(",")]
    return [n for n in names if n and n.upper() != "TBA"]


def natural_key(s: str):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", s)]


# --------------------------------------------------------------------------- parsing

def parse_schedule(html: str) -> list[dict]:
    """Parse the 'Sections Found' page into raw section dicts."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    sections = []
    for th in soup.find_all("th", class_=["ddlabel", "ddtitle"]):
        link = th.find("a")
        if link is None:
            continue
        m = TITLE_RE.match(clean(link.get_text(" ")))
        if not m:
            continue
        header_row = th.find_parent("tr")
        body_row = header_row.find_next_sibling("tr") if header_row else None
        body = body_row.find("td") if body_row else None
        sections.append(parse_section(m, body))
    return sections


def parse_section(m: re.Match, body) -> dict:
    info_text = body.get_text("\n") if body is not None else ""
    credits = re.search(r"([\d.]+)\s+Credits", info_text)
    sched_type = re.search(r"^\s*(\S[^\n]*?)\s+Schedule Type\s*$", info_text, re.MULTILINE)
    levels = re.search(r"Levels:\s*([^\n]+)", info_text)

    meetings = []
    table = body.find("table") if body is not None else None
    if table is not None:
        columns = {}
        header = table.find("tr")
        if header is not None:
            for i, cell in enumerate(header.find_all("th")):
                columns[clean(cell.get_text(" ")).lower()] = i
        col = lambda name, default: columns.get(name, default)  # noqa: E731
        instructors: list[str] = []
        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if not cells:
                continue

            def cell(name, default, raw=False):
                i = col(name, default)
                if i >= len(cells):
                    return ""
                return cells[i].get_text("") if raw else clean(cells[i].get_text(" "))

            start, end = parse_time_range(cell("time", 1))
            days = parse_days(cell("days", 2))
            place = short_place(cell("where", 3))
            for name in parse_instructors(cell("instructors", 6, raw=True)):
                if name not in instructors:
                    instructors.append(name)
            if start is None or end is None or not days:
                meetings.append({"days": [], "start": None, "end": None, "place": place})
            else:
                meetings.append({"days": days, "start": start, "end": end, "place": place})
    else:
        instructors = []

    return {
        "title": clean(m.group("title")),
        "crn": m.group("crn"),
        "subj": m.group("subj"),
        "num": m.group("num"),
        "group": m.group("group"),
        "credits": float(credits.group(1)) if credits else None,
        "levels": clean(levels.group(1)) if levels else None,
        "schedule_type": clean(sched_type.group(1)) if sched_type else None,
        "instructors": instructors,
        "meetings": meetings,
    }


# --------------------------------------------------------------------------- shaping

class Indexer:
    def __init__(self):
        self.items: list[str] = []
        self.pos: dict[str, int] = {}

    def __call__(self, value: str) -> int:
        if value not in self.pos:
            self.pos[value] = len(self.items)
            self.items.append(value)
        return self.pos[value]


def level_code(levels: set[str], num: str) -> str | None:
    tags = set()
    for lv in levels:
        for part in lv.split(","):
            p = part.strip().lower()
            if not p:
                continue
            if p.startswith("under"):
                tags.add("UG")
            elif p.startswith(("grad", "master", "doct", "phd")):
                tags.add("GR")
    if tags:
        return "+".join(sorted(tags, key=lambda t: t != "UG"))
    return None


def finalize_term(term: str, name: str, raw: list[dict], updated: str | None = None,
                  source: str = "BannerWeb dynamic schedule") -> dict:
    places, people = Indexer(), Indexer()
    courses: dict[str, dict] = {}

    for r in raw:
        mnum = re.match(r"^(\d+)([A-Z]*)$", r["num"])
        base_num, ctype = (mnum.group(1), mnum.group(2)) if mnum else (r["num"], "")
        key = f'{r["subj"]} {base_num}'
        c = courses.setdefault(key, {
            "subj": r["subj"], "num": base_num, "lecture_titles": Counter(), "other_titles": Counter(),
            "lecture_credits": [], "credits": [], "levels": set(), "components": {},
        })
        if ctype == "":
            c["lecture_titles"][r["title"]] += 1
            if r["credits"] is not None:
                c["lecture_credits"].append(r["credits"])
        else:
            c["other_titles"][COMPONENT_WORDS.sub("", r["title"]).strip() or r["title"]] += 1
        if r["credits"] is not None:
            c["credits"].append(r["credits"])
        if r["levels"]:
            c["levels"].add(r["levels"])

        comp = c["components"].setdefault(ctype, {"labels": Counter(), "sections": {}})
        if r["schedule_type"]:
            comp["labels"][r["schedule_type"]] += 1

        merged: dict[tuple, list[str]] = {}
        tba = False
        for mt in r["meetings"]:
            if mt["start"] is None:
                tba = True
                continue
            for d in mt["days"]:
                merged.setdefault((d, mt["start"], mt["end"]), [])
                if mt["place"] and mt["place"] not in merged[(d, mt["start"], mt["end"])]:
                    merged[(d, mt["start"], mt["end"])].append(mt["place"])
        meetings = [[d, s, e, places(" / ".join(p)) if p else -1]
                    for (d, s, e), p in sorted(merged.items())]
        section = {
            "crn": r["crn"],
            "group": r["group"],
            "people": [people(n) for n in r["instructors"]],
            "meetings": meetings,
        }
        if tba and not meetings:
            section["tba"] = 1
        comp["sections"].setdefault(r["crn"], section)

    out_courses = []
    for key, c in courses.items():
        comps = []
        for ctype in sorted(c["components"], key=lambda t: (t != "", t)):
            comp = c["components"][ctype]
            label = comp["labels"].most_common(1)[0][0] if comp["labels"] else \
                TYPE_LABELS.get(ctype, f"{ctype} section")
            secs = sorted(comp["sections"].values(), key=lambda s: (natural_key(s["group"]), s["crn"]))
            comps.append({"type": ctype, "label": label, "sections": secs})
        title = (c["lecture_titles"] or c["other_titles"]).most_common(1)[0][0]
        entry = {"code": key, "title": title}
        cred = c["lecture_credits"] or c["credits"]
        if cred:
            v = max(cred)
            entry["credits"] = int(v) if v == int(v) else v
        lv = level_code(c["levels"], c["num"])
        if lv:
            entry["level"] = lv
        entry["components"] = comps
        out_courses.append(entry)

    out_courses.sort(key=lambda e: (e["code"].split(" ")[0], natural_key(e["code"].split(" ")[1])))
    return {
        "schema": SCHEMA,
        "term": term,
        "name": name,
        "updated": updated or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "places": places.items,
        "people": people.items,
        "courses": out_courses,
    }


def content_hash(data: dict) -> str:
    body = {k: v for k, v in data.items() if k != "updated"}
    return hashlib.sha1(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def write_term(out: Path, data: dict, keep_updated: bool = True, max_terms: int | None = None) -> bool:
    """Write data/<term>.json and refresh data/terms.json. Returns True if anything changed."""
    out.mkdir(parents=True, exist_ok=True)
    index_path = out / "terms.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"terms": []}
    entries = {t["code"]: t for t in index.get("terms", [])}

    h = content_hash(data)
    prev = entries.get(data["term"])
    if keep_updated and prev and prev.get("hash") == h and (out / f'{data["term"]}.json').exists():
        return False

    (out / f'{data["term"]}.json').write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    entries[data["term"]] = {
        "code": data["term"],
        "name": data["name"],
        "updated": data["updated"],
        "courses": len(data["courses"]),
        "sections": sum(len(cp["sections"]) for c in data["courses"] for cp in c["components"]),
        "hash": h,
    }
    ordered = sorted(entries.values(), key=lambda t: t["code"], reverse=True)
    if max_terms:
        for stale in ordered[max_terms:]:
            (out / f'{stale["code"]}.json').unlink(missing_ok=True)
        ordered = ordered[:max_terms]
    index_path.write_text(json.dumps({"schema": SCHEMA, "terms": ordered}, ensure_ascii=False, indent=1),
                          encoding="utf-8")
    return True


# --------------------------------------------------------------------------- network

def make_session():
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    retry = Retry(total=4, backoff_factor=3, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=frozenset(["GET", "POST"]))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


def fetch_terms(session) -> list[tuple[str, str]]:
    from bs4 import BeautifulSoup

    r = session.get(TERMS_URL, timeout=60)
    r.raise_for_status()
    soup = BeautifulSoup(r.content, "html.parser")
    select = soup.find("select", attrs={"name": "p_term"})
    terms = []
    for opt in (select.find_all("option") if select else []):
        code = (opt.get("value") or "").strip()
        if re.fullmatch(r"\d{6}", code):
            terms.append((code, clean(opt.get_text()).replace("(View only)", "").strip()))
    return terms


def fetch_subjects(session, term: str) -> list[str]:
    from bs4 import BeautifulSoup

    r = session.post(SUBJECTS_URL, data={"p_calling_proc": "bwckschd.p_disp_dyn_sched", "p_term": term},
                     timeout=60)
    r.raise_for_status()
    soup = BeautifulSoup(r.content, "html.parser")
    select = soup.find("select", attrs={"name": "sel_subj"})
    options = select.find_all("option") if select else soup.find_all("option")
    return [o.get("value") for o in options if (o.get("value") or "").isalpha() and o.get("value").isupper()]


def fetch_schedule(session, term: str, subjects: list[str]) -> str:
    form = [("term_in", term), ("sel_subj", "dummy")] + [("sel_subj", s) for s in subjects]
    form += [(k, "dummy") for k in ("sel_day", "sel_schd", "sel_insm", "sel_camp", "sel_levl",
                                     "sel_sess", "sel_instr", "sel_ptrm", "sel_attr")]
    form += [("sel_crse", ""), ("sel_title", ""), ("sel_from_cred", ""), ("sel_to_cred", ""),
             ("begin_hh", "0"), ("begin_mi", "0"), ("begin_ap", "a"),
             ("end_hh", "0"), ("end_mi", "0"), ("end_ap", "a")]
    r = session.post(SCHEDULE_URL, data=form, timeout=240)
    r.raise_for_status()
    r.encoding = r.apparent_encoding if not r.encoding or r.encoding.lower() == "iso-8859-1" else r.encoding
    return r.text


def scrape_term(session, term: str) -> list[dict]:
    subjects = fetch_subjects(session, term)
    if not subjects:
        return []
    try:
        raw = parse_schedule(fetch_schedule(session, term, subjects))
        if raw:
            return raw
    except Exception as exc:  # the all-subjects request can be heavy; fall back to batches
        print(f"  full request failed ({exc}); retrying in batches", file=sys.stderr)
    raw = []
    for i in range(0, len(subjects), 8):
        raw += parse_schedule(fetch_schedule(session, term, subjects[i:i + 8]))
        time.sleep(1)
    return raw


# --------------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--terms", nargs="*", help="term codes, e.g. 202601 (Fall 2026-2027)")
    ap.add_argument("--latest", type=int, default=3, help="scrape the N most recent terms (default 3)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--max-terms", type=int, default=0, help="prune data/ to the newest N terms (default 0 = keep the whole archive)")
    ap.add_argument("--html", help="parse a saved 'Sections Found' HTML file instead of fetching")
    args = ap.parse_args(argv)
    out = Path(args.out)

    if args.html:
        term = (args.terms or current_terms(1))[0]
        raw = parse_schedule(Path(args.html).read_text(encoding="utf-8", errors="replace"))
        data = finalize_term(term, term_name(term), raw)
        write_term(out, data, max_terms=args.max_terms)
        print(f"{term}: {len(data['courses'])} courses from {args.html}")
        return 0

    session = make_session()
    names = {}
    if args.terms:
        codes = args.terms
    else:
        try:
            listed = fetch_terms(session)
            names = dict(listed)
            codes = sorted(names, reverse=True)[: args.latest]
        except Exception as exc:
            print(f"Could not read the term list ({exc}); using date-based terms", file=sys.stderr)
            codes = current_terms(args.latest)

    failures = 0
    for code in codes:
        print(f"Scraping {code} ({names.get(code) or term_name(code)})")
        try:
            raw = scrape_term(session, code)
        except Exception as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            failures += 1
            continue
        if not raw:
            print("  no sections published yet, skipped")
            continue
        data = finalize_term(code, term_name(code), raw)
        changed = write_term(out, data, max_terms=args.max_terms)
        print(f"  {len(data['courses'])} courses, {len(raw)} sections, {'updated' if changed else 'unchanged'}")
        time.sleep(2)
    return 1 if failures == len(codes) else 0


if __name__ == "__main__":
    sys.exit(main())
