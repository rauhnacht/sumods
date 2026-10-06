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

  python scraper/programs.py                              # every programme and its -DM (double major) variant
  python scraper/programs.py --programs BSCS BSCS-DM      # BSCS as a major, and as a double major
  python scraper/programs.py --notes                      # the rule sentences under each area, from the stored data
  python scraper/programs.py --programs PHIL-MINOR MATH-MINOR  # minors (P_PROGRAM=PHIL-MINOR), all entry terms
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

# The summary page names each area's minimum credits/ECTS but not which courses satisfy it —
# that list lives on this separate endpoint, one call per area. P_AREA is "<PROGRAM>_<suffix>"
# for a programme's own electives, or "FC_<school>" + P_FAC for the cross-faculty pool.
AREA_URL = ("https://suis.sabanciuniv.edu/HbbmWeb/SU_DEGREE.p_list_courses"
            "?P_TERM={term}&P_AREA={area}&P_PROGRAM={program}&P_LANG=EN&P_LEVEL=UG")
# Banner names an area <PROGRAM>_<suffix>. The standard spelling is CEL / AEL / FEL (BSCS); the first
# BSEE links we saw used ARE / FRE, so those stay as the fallback. An unknown area code answers
# with a 500, which is how the wrong spelling announces itself.
AREA_SUFFIXES = {"core": ["CEL"], "area": ["AEL", "ARE"], "free": ["FEL", "FRE"]}
AREA_SUFFIX = {kind: names[0] for kind, names in AREA_SUFFIXES.items()}
WORKING: dict[tuple[str, str], str] = {}      # (programme, kind) -> the area code that answered
HARD_FAIL: set[tuple[str, str]] = set()       # (P_PROGRAM, area) the server doesn't know — asked once per run
# FC_SOM is what the actual degree-detail page links to for the business school's courses;
# FC_SBS is tried as a fallback in case a different programme or term uses that code instead.
FACULTY_AREAS = [("FC_FENS", "E"), ("FC_FASS", "S"), ("FC_SOM", "M"), ("FC_SBS", "M")]
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
DM = "-DM"        # P_PROGRAM=BSCS-DM is the double-major version of BSCS's requirements

# Programmes that did not exist before some entry term: nothing earlier is fetched, and anything stored earlier is dropped.
# The Data Science and Analytics double major (BSDSA-DM) takes its first students in Fall 2025-2026; the main programme goes back to 2019.
FIRST_ENTRY = {"BSDSA-DM": "202501"}

# Minors: P_PROGRAM=PHIL-MINOR. Their page has the same layout as a major's, but the course lists sit on the
# page itself (no p_list_courses links) and there are no university / free / faculty areas.
MINOR = "-MINOR"
MINORS = ["ARTTC-MINOR", "BSE-MINOR", "ANALY-MINOR", "CHEM-MINOR", "CONF-MINOR", "DECB-MINOR", "ENERG-MINOR",
          "ENTREP-MINOR", "FIN-MINOR", "GENDER-MINOR", "IS-MINOR", "MKTG-MINOR", "MATH-MINOR", "PHIL-MINOR",
          "PHYS-MINOR", "SCP-MINOR", "SUST-MINOR"]


def is_minor(code: str) -> bool:
    return code.endswith(MINOR)


def minor_name(title: str, code: str) -> str:
    """"PHILOSOPHY MINOR UNDERGRADUATE PROGRAM (PHIL-MINOR)" -> "Philosophy (Minor)"."""
    t = re.sub(r"\(\s*[A-Z0-9-]+\s*\)\s*$", "", clean(title or ""))
    t = re.sub(r"\bUNDERGRADUATE\s+PROGRAM(ME)?\b", "", t, flags=re.I)
    t = re.sub(r"\bMINOR\b", "", t, flags=re.I)
    t = clean(t).strip(" -–:")
    return f"{t.title() if t.isupper() else t} (Minor)" if t else code


# A double major is the programme code plus -DM (BSCS -> BSCS-DM), except where the university breaks the
# pattern: Industrial Engineering is BSMS, but its double major is BSIE-DM.
DM_CODES = {"BSMS": "BSIE-DM"}
DM_BASE = {dm: base for base, dm in DM_CODES.items()}


def dm_of(code: str) -> str:
    return DM_CODES.get(code, code + DM)


def base_of(code: str) -> str:
    if code in DM_BASE:
        return DM_BASE[code]
    return code[: -len(DM)] if code.endswith(DM) else code


def programme_name(code: str) -> str:
    if is_minor(code):
        return code            # replaced by the page's own title once it has been read (minor_name)
    name = PROGRAMS.get(base_of(code), code)
    return f"{name} (Double Major)" if code.endswith(DM) else name


def all_programmes() -> list[str]:
    """Every programme, then its double-major variant, then the minors — the primary ones first, so a run
    that runs out of budget has finished the majority of students' programmes."""
    return list(PROGRAMS) + [dm_of(code) for code in PROGRAMS] + MINORS


def area_candidates(program: str, kind: str) -> list[str]:
    """Spellings to try for a programme's own electives. A double major tries BSCS-DM_CEL and
    then BSCS_CEL (always with P_PROGRAM=BSCS-DM); the standard suffix goes before the legacy one."""
    prefixes = [program] if program == base_of(program) else [program, base_of(program)]
    if is_minor(program):
        prefixes = [program[: -len(MINOR)], program]      # MKTG-MINOR's electives are MKTG_AEL (P_PROGRAM stays MKTG-MINOR)
    return [f"{prefix}_{suffix}" for suffix in AREA_SUFFIXES[kind] for prefix in prefixes]


def make_probe_session():
    """Like make_session, but a 500 is not retried: Banner uses it for "no such area/programme",
    and retrying those for every wrong spelling would cost minutes per entry term."""
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = make_session()
    retry = Retry(total=2, read=0, backoff_factor=1, status_forcelist=(429, 502, 503, 504),
                  allowed_methods=frozenset(["GET"]))              # read=0: a page that hangs is not asked again
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


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
    # these two are credit/ECTS *floors* the required+core+area courses must add up to, not
    # areas with their own course list — see basic_science_engineering_note() below
    ("basicscience", ("basic science", "basic science courses", "temel bilim")),
    ("engineering", ("engineering", "engineering courses", "mühendislik")),
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


def parse_area_courses(html: str) -> list[str]:
    """A p_list_courses page: just a table of courses for one requirement area. Returns
    codes in document order, deduplicated."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    seen: dict[str, None] = {}
    for tr in soup.find_all("tr"):
        cells = [clean(c.get_text(" ")) for c in tr.find_all(["th", "td"])]
        code_cell = next((c for c in cells if CODE_RE.match(c)), None)
        if not code_cell:
            continue
        m = CODE_RE.match(code_cell)
        seen.setdefault(f"{m.group(1)} {m.group(2)}", None)
    if not seen:
        # some area pages are a bare list (no table) — fall back to scanning all text lines
        for line in soup.get_text("\n").split("\n"):
            line = clean(line)
            m = CODE_RE.match(line)
            if m:
                seen.setdefault(f"{m.group(1)} {m.group(2)}", None)
    return list(seen)


SUFFIX_KIND = {"CEL": "core", "AEL": "area", "ARE": "area", "FEL": "free", "FRE": "free"}
RAW_AREA = re.compile(r"P_AREA=([A-Za-z0-9_\-]+)([^\"'<>\s]*)", re.I)


def _kind_for(area: str, label: str = "") -> str | None:
    if area.startswith("FC_"):
        return "faculty"
    return kind_of(label) or SUFFIX_KIND.get(area.rsplit("_", 1)[-1].upper())


def area_links(soup, raw: str = "") -> list[dict]:
    """Every p_list_courses link on a degree page, with the area it belongs to. The page links
    each area's course list itself, so its P_AREA / P_FAC / P_PROGRAM are the real ones — no
    guessing (unknown area codes 500). Falls back to scanning the raw HTML for P_AREA=… so links
    that live in an onclick or an inline script are found too."""
    import html as htmlmod
    from urllib.parse import parse_qs

    out = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "p_list_courses" not in href.lower():
            continue
        query = parse_qs(href.split("p_list_courses", 1)[1].lstrip("?&") if "p_list_courses" in href else "")
        area = (query.get("P_AREA") or [""])[0]
        if not area:
            continue
        row = a.find_parent("tr")
        label = clean(row.find(["td", "th"]).get_text(" ")) if row and row.find(["td", "th"]) else ""
        kind = _kind_for(area, label) or kind_of(clean(a.get_text(" ")))
        out.append({"area": area, "fac": (query.get("P_FAC") or [""])[0], "kind": kind, "label": label,
                    "program": (query.get("P_PROGRAM") or [""])[0]})
    if out or not raw:
        return out
    seen = set()
    for m in RAW_AREA.finditer(htmlmod.unescape(raw)):
        query = parse_qs(m.group(2).lstrip("&"))
        fac = (query.get("P_FAC") or [""])[0]
        if (m.group(1), fac) in seen:
            continue
        seen.add((m.group(1), fac))
        out.append({"area": m.group(1), "fac": fac, "kind": _kind_for(m.group(1)), "label": "",
                    "program": (query.get("P_PROGRAM") or [""])[0]})
    return out


def parse_page(html: str) -> dict:
    """Summary table plus one course list per area, in document order."""
    from bs4 import BeautifulSoup
    from bs4.element import NavigableString, Tag

    soup = BeautifulSoup(html, "html.parser")
    links = area_links(soup, html)              # before scripts are stripped: URLs can live in them
    for tag in soup(["script", "style"]):
        tag.decompose()

    title = ""
    for text in soup.stripped_strings:
        if "program" in text.lower() and ("undergraduate" in text.lower() or "lisans" in text.lower()):
            title = clean(text)
            break

    # ---- summary: rows whose first cell names an area and that carry numbers
    summary: list[dict] = []
    unknown: list[str] = []
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
            if kind in ("basicscience", "engineering"):
                # the summary gives a credit/ECTS floor here, but which courses count toward
                # it isn't listed anywhere on this page — the university says that's a
                # property of the course itself (stated in its syllabus), not a fixed list
                entry["untracked"] = True
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
        elif in_summary and values and not kind and cells[0]:
            unknown.append(cells[0])               # a summary row with numbers we have no name for
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
            if "t_kategori_row_desc" in (node.get("class") or []):
                # the sentence under an area's heading ("Minimum 6 credits must be taken from list… At least 9
                # credits from EE 4XX…"): the rules the course lists alone don't show
                if current:
                    text = clean(node.get_text(" ")).strip(" :")
                    if text:
                        groups[current]["note"] = text
                continue
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
    return {"title": title, "groups": ordered, "credits": credits, "links": links, "unrecognised": unknown,
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


def complete(store: dict, term: str) -> bool:
    """Stored and with its elective lists filled (runs before the p_list_courses fix left
    core/area/free empty — those get fetched again)."""
    entry = store["entries"].get(term)
    for _ in range(20):
        if not entry or "sameAs" not in entry:
            break
        entry = store["entries"].get(entry["sameAs"])
    if not entry or "groups" not in entry:
        return False
    if is_minor(store.get("program", "")):
        return True              # a minor's lists are all on its own page; nothing more to fetch
    return all(g.get("courses") or g.get("any") for g in entry["groups"]
               if g.get("kind") in ("core", "area", "free", "faculty"))


def put_entry(store: dict, hashes: dict, term: str, entry: dict) -> None:
    """Store one entry term, pointing it at an identical earlier one (`sameAs`) so a requirement set
    that didn't change across cohorts is kept once.

    Two traps the naive version fell into: an unchanged term that is itself the one others point at
    must stay a full entry (pointing it at itself wiped its data), and whenever a term stops holding
    its old content, the terms that were pointing at it keep that old content instead of silently
    inheriting the new one."""
    h = digest({k: v for k, v in entry.items() if k != "source"})
    entries = store["entries"]
    target = hashes.get(h)                       # a term already holding exactly this content
    if target == term:
        entries[term] = entry                    # unchanged: stays a full entry
        return
    old = entries.get(term)
    if old and "sameAs" not in old:              # `term` is about to give up its old content
        old_h = digest({k: v for k, v in old.items() if k != "source"})
        followers = [t for t, e in entries.items() if e.get("sameAs") == term and t != term]
        if followers:
            entries[followers[0]] = old          # the old content lives on under the first follower
            for t in followers[1:]:
                entries[t] = {"sameAs": followers[0]}
            hashes[old_h] = followers[0]
        else:
            hashes.pop(old_h, None)
    if target:
        entries[term] = {"sameAs": target}
    else:
        hashes[h] = term
        entries[term] = entry


def digest(entry: dict) -> str:
    return hashlib.sha1(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:12]


def fetch_area(session, term: str, program: str, area: str, fac: str = "") -> list[str] | None:
    """One p_list_courses call. None means the request failed (network, or a 5xx — which is
    how BannerWeb answers an area code it doesn't know); [] means a real, empty list."""
    url = AREA_URL.format(term=term, area=area, program=program) + (f"&P_FAC={fac}" if fac else "")
    try:
        res = session.get(url, timeout=45, headers={"Referer": URL.format(term=term, program=program)})
        res.raise_for_status()
    except Exception as exc:
        reason = "server error" if "500" in str(exc) else str(exc)[:120]
        print(f"    {area}{'/' + fac if fac else ''}: {reason}", file=sys.stderr)
        if "500" in str(exc) and not fac:
            HARD_FAIL.add((program, area))          # an unknown area name stays unknown for every entry term
        return None
    courses = parse_area_courses(res.text)
    if not courses:
        print(f"    {area}{'/' + fac if fac else ''}: answered but had no course rows ({len(res.text)} bytes)",
              file=sys.stderr)
        if program.endswith(DM) and not fac:
            HARD_FAIL.add((program, area))          # a double major's list under the major's name is empty by nature
    return courses


def borrow_from_major(groups: list[dict], program: str, term: str, out_dir: Path) -> list[str]:
    """A double major's own elective lists aren't published under any name we can find: BSCS-DM_CEL
    and friends answer 500, and BSCS_CEL asked as BSCS-DM answers with no rows. Those groups take the
    main programme's list for the same entry term (credit targets still come from the double-major
    page) and say so with `borrowed`, so the app can tell the student the list is the major's."""
    base = base_of(program)
    path = out_dir / f"{base}.json"
    if base == program or not path.exists():
        return []
    entries = json.loads(path.read_text(encoding="utf-8")).get("entries", {})
    entry = entries.get(term)
    for _ in range(20):
        if not entry or "sameAs" not in entry:
            break
        entry = entries.get(entry["sameAs"])
    if not entry or "groups" not in entry:
        return []
    donors: dict[str, dict] = {}
    for g in entry["groups"]:
        if g.get("courses"):
            donors.setdefault(g["kind"], g)
    done = []
    for g in groups:
        if g["kind"] in AREA_SUFFIX and not g.get("courses") and g["kind"] in donors:
            g["courses"] = list(donors[g["kind"]]["courses"])
            g["borrowed"] = base
            done.append(g["kind"])
    return done


def fill_area_courses(session, term: str, program: str, groups: list[dict], delay: float,
                      links: list[dict] | None = None) -> None:
    """Fill each empty core/area/free/faculty group from its p_list_courses page. Area codes come
    from the links on the degree page itself when it has them (exact, per programme); otherwise
    the known spellings are tried in turn and the one that answers is remembered for the next
    entry term, so a wrong spelling costs one quick request per programme, not one per term."""
    links = links or []
    for group in groups:
        kind = group["kind"]
        if group.get("courses") or kind not in (*AREA_SUFFIX, "faculty"):
            continue
        found = [l for l in links if l["kind"] == kind
                 and (not l["label"] or clean(l["label"]).lower().strip(" *:") == clean(group["name"]).lower()
                      or kind_of(l["label"]) == kind)]
        guessed = not found
        if guessed and kind != "faculty" and program.endswith(DM):
            continue              # a double major's electives are the major's own: borrow_from_major fills them
        if guessed:
            if kind == "faculty":
                found = [{"area": a, "fac": f} for a, f in FACULTY_AREAS]
            else:
                names = area_candidates(program, kind)
                known = WORKING.get((program, kind))
                if known in names:
                    names.remove(known)
                    names.insert(0, known)
                found = [{"area": a, "fac": "", "alt": True} for a in names]

        codes: dict[str, None] = {}
        worked = 0
        used = ""
        faculties_done: set[str] = set()
        for link in found:
            if link["fac"] and link["fac"] in faculties_done:
                continue          # FC_SOM already answered for P_FAC=M, skip the FC_SBS fallback
            if link.get("alt") and codes:
                break             # an earlier spelling already answered
            if link.get("alt") and (link.get("program") or program, link["area"]) in HARD_FAIL:
                continue          # already learned this run that it doesn't answer
            got = fetch_area(session, term, link.get("program") or program, link["area"], link["fac"])
            time.sleep(delay)
            if got is None:
                continue
            worked += 1
            if got and link["fac"]:
                faculties_done.add(link["fac"])
            if got and link.get("alt"):
                WORKING[(program, kind)] = used = link["area"]
            for c in got:
                codes.setdefault(c, None)
        group["courses"] = list(codes)
        source = f"guessed {used}" if guessed and used else "guessed codes" if guessed else "codes from the degree page"
        print(f"    {kind}: {len(codes)} courses from {worked}/{len(found)} list(s), {source}")


EXPECTED_KINDS = ["university", "required", "core", "area", "free", "faculty"]


def summarise(data_dir: Path) -> list[str]:
    """One line per stored programme: the newest entry's groups and how many courses each holds,
    with MISSING for an expected group that isn't there and EMPTY for one with no courses.
    Needs no network — it answers "did the scraper get anything?" from data/programs/."""
    lines = []
    for path in sorted((data_dir / "programs").glob("*.json")):
        if path.stem in ("index", "overrides"):
            continue
        store = json.loads(path.read_text(encoding="utf-8"))
        entries = store.get("entries", {})
        if not entries:
            lines.append(f"{path.stem:10} no entries")
            continue
        term = sorted(entries)[-1]
        entry = entries[term]
        for _ in range(20):
            if "sameAs" not in entry:
                break
            entry = entries[entry["sameAs"]]
        by_kind: dict[str, list[dict]] = {}
        for g in entry.get("groups", []):
            by_kind.setdefault(g.get("kind"), []).append(g)
        parts = []
        for kind in ([k for k in by_kind if k != "total"] if is_minor(path.stem) else EXPECTED_KINDS):
            gs = by_kind.get(kind)
            if not gs:
                parts.append(f"{kind}=MISSING")
                continue
            n = sum(len(g.get("courses") or []) for g in gs)
            parts.append(f"{kind}={n}" + ("" if n or any(g.get("any") for g in gs) else " EMPTY"))
        extra = [] if is_minor(path.stem) else [k for k in by_kind if k not in EXPECTED_KINDS and k != "total"]
        lines.append(f"{path.stem:10} {term}  " + "  ".join(parts) + (f"  (+{','.join(extra)})" if extra else "")
                     + f"  [{len(entries)} entry terms]")
    return lines


def notes_report(data_dir: Path) -> list[str]:
    """Every sentence the degree pages put under an area's heading, per programme, for the newest entry term
    and again for each older one that differs. For finding rules the course lists don't carry (credits that
    must come from EE 4xx, "one of these two", …). Needs no network."""
    lines = []
    for path in sorted((data_dir / "programs").glob("*.json")):
        if path.stem in ("index", "overrides"):
            continue
        entries = json.loads(path.read_text(encoding="utf-8")).get("entries", {})
        seen: dict[str, list[str]] = {}
        for term in sorted(entries, reverse=True):
            entry = entries[term]
            for _ in range(20):
                if "sameAs" not in entry:
                    break
                entry = entries[entry["sameAs"]]
            for g in entry.get("groups", []):
                if g.get("note"):
                    seen.setdefault(f"{g['name']}: {g['note']}", []).append(term)
        for text, terms in seen.items():
            span = terms[0] if len(terms) == 1 else f"{terms[-1]}–{terms[0]}"
            lines.append(f"{path.stem:10} {span:14} {text}")
    return lines


def probe(program: str, term: str) -> list[str]:
    """Look at one programme's live pages and say what's there: the groups and summary rows read,
    every area link found (and how), and for each area which spellings the server answers and how
    many course rows come back. For working out why a programme's lists are empty."""
    session = make_probe_session()
    out = [f"== {program} entered {term}"]
    url = URL.format(term=term, program=program)
    try:
        res = session.get(url, timeout=60)
    except Exception as exc:
        return out + [f"degree page: failed ({str(exc)[:100]})"]
    out.append(f"degree page: HTTP {res.status_code}, {len(res.text)} bytes")
    if res.status_code != 200:
        return out
    parsed = parse_page(res.text)
    for g in parsed["groups"]:
        nums = ", ".join(f"{k}={g[k]}" for k in ("credits", "ects", "minCourses") if k in g)
        out.append(f"  group  {g['kind']:12} {g['name']!r:34} {nums}  courses on page: {len(g['courses'])}")
    if parsed.get("unrecognised"):
        out.append(f"  summary rows with numbers but no known name: {parsed['unrecognised']}")
    out.append(f"  area links found: {len(parsed['links'])}")
    for l in parsed["links"]:
        out.append(f"    {l['kind'] or '?':10} P_AREA={l['area']}  P_FAC={l['fac'] or '-'}  P_PROGRAM={l.get('program') or '-'}")
    import re as _re
    for m in list(_re.finditer(r"p_list_courses", res.text, _re.I))[:2]:
        snippet = " ".join(res.text[max(0, m.start() - 90): m.end() + 140].split())
        out.append(f"  html around a p_list_courses mention: …{snippet}…")
    base = base_of(program)
    for kind in ("core", "area", "free"):
        tries = [(a, program) for a in area_candidates(program, kind)]
        if program != base:
            tries += [(a, base) for a in area_candidates(base, kind)]       # the major's own list, for comparison
        for area, p_program in tries:
            try:
                r = session.get(AREA_URL.format(term=term, area=area, program=p_program), timeout=45)
                rows = len(parse_area_courses(r.text)) if r.status_code == 200 else None
                result = f"HTTP {r.status_code}" + (f", {rows} course rows, {len(r.text)} bytes" if rows is not None else "")
            except Exception as exc:
                result = f"failed ({str(exc)[:60]})"
            out.append(f"  try {kind:5} P_AREA={area:14} P_PROGRAM={p_program:10} -> {result}")
            time.sleep(0.5)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--programs", nargs="*", default=all_programmes(),
                    help="programme codes, e.g. BSEE BSMAT BSCS-DM (default: all, with double-major variants)")
    ap.add_argument("--entries", nargs="*", help="entry terms (default: fall + spring since 2019)")
    ap.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--delay", type=float, default=1.0)
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch every entry term, not just the recent ones and those still incomplete")
    ap.add_argument("--budget", type=float, default=0,
                    help="minutes to spend before saving and stopping (default 0 = no limit)")
    ap.add_argument("--no-areas", action="store_true",
                    help="skip the extra per-area fetches for core/area/free/faculty course lists")
    ap.add_argument("--html", help="parse a saved degree_detail page (summary + inline lists)")
    ap.add_argument("--area-html", help="parse a saved p_list_courses page and print the course codes found")
    ap.add_argument("--dump", help="save the first fetched page here and stop")
    ap.add_argument("--dump-area", help="fetch one area's page (needs --programs/--entries and "
                    "--dump-area = core|area|free|faculty) and save it here, then stop")
    ap.add_argument("--print", action="store_true", help="show what was parsed, write nothing")
    ap.add_argument("--summary", action="store_true",
                    help="list what data/programs/ holds per programme (no network) and stop")
    ap.add_argument("--notes", action="store_true",
                    help="list the note sentences stored under each area (no network) and stop")
    ap.add_argument("--probe", action="store_true",
                    help="query --programs at --entries and report what the pages contain (writes nothing)")
    args = ap.parse_args(argv)

    if args.summary:
        print("\n".join(summarise(Path(args.data))))
        return 0
    if args.notes:
        print("\n".join(notes_report(Path(args.data))))
        return 0
    if args.probe:
        targets = args.programs if "--programs" in (argv or sys.argv) else ["BSCS"]
        for program in targets:
            for entry_term in (args.entries or ["202601"]):
                print("\n".join(probe(program, entry_term)))
        return 0

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

    if args.area_html:
        codes = parse_area_courses(Path(args.area_html).read_text(encoding="utf-8", errors="replace"))
        print(f"{len(codes)} courses: {codes}")
        return 0 if codes else 1

    if args.dump_area:
        program = args.programs[0]
        term = (args.entries or [default_entries(newest)[0]])[0]
        session = make_session()
        if args.dump_area == "faculty":
            url = f"{AREA_URL.format(term=term, area='FC_FENS', program=program)}&P_FAC=E"
        else:
            area = f"{program}_{AREA_SUFFIX[args.dump_area]}"
            url = AREA_URL.format(term=term, area=area, program=program)
        res = session.get(url, timeout=45)
        Path(args.dump).write_text(res.text, encoding="utf-8") if args.dump else print(res.text[:3000])
        if args.dump:
            print(f"saved {args.dump} ({url})")
        return 0

    session = make_session()
    probe = make_probe_session()
    deadline = time.monotonic() + args.budget * 60 if args.budget > 0 else float("inf")
    out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for program in args.programs:
        if time.monotonic() > deadline:
            break
        path = out_dir / f"{program}.json"
        store = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
            "program": program, "name": programme_name(program), "entries": {}}
        first = FIRST_ENTRY.get(program)
        if first:
            store["entries"] = {t: e for t, e in store["entries"].items() if t >= first}
        hashes = {}
        for t, e in store["entries"].items():
            if "sameAs" not in e:
                hashes.setdefault(digest({k: v for k, v in e.items() if k != "source"}), t)
        recent = set(sorted(entries, reverse=True)[:2])     # this year's cohorts can still change
        is_dm = program.endswith(DM)
        minor = is_minor(program)
        sparse = is_dm or minor                              # these exist only for some entry terms
        misses = 0                                           # consecutive entry terms with no page
        for entry_term in entries:
            if first and entry_term < first:
                continue                                    # the programme didn't exist for that cohort
            if time.monotonic() > deadline:
                print("  budget reached — saving; the next run continues from here")
                break
            have = store["entries"].get(entry_term)
            if not args.refresh and have and entry_term not in recent and complete(store, entry_term):
                continue                                    # an older cohort's rules don't change
            url = URL.format(term=entry_term, program=program)
            print(f"{program} {entry_term}")
            try:
                res = (probe if sparse else session).get(url, timeout=(10, 25) if sparse else 60)   # a missing minor/DM page can hang: give up fast
                res.raise_for_status()
            except Exception as exc:
                print(f"  failed: {'no such programme page' if '500' in str(exc) else exc}", file=sys.stderr)
                misses += 1
                if sparse and misses >= 3:
                    print(f"  {program}: nothing for {misses} entry terms in a row — leaving the older ones")
                    break
                continue
            if args.dump:
                Path(args.dump).write_text(res.text, encoding="utf-8")
                print(f"  saved {args.dump}")
                return 0
            parsed = parse_page(res.text)
            if not parsed["groups"]:
                print("  no requirements on that page (programme not open to that entry term?)")
                misses += 1
                if sparse and misses >= 3:
                    print(f"  {program}: nothing for {misses} entry terms in a row — leaving the older ones")
                    break
                continue
            misses = 0
            if minor:
                # the lists are on the page; an empty "Faculty Courses" footnote group isn't an area of a minor
                parsed["groups"] = [g for g in parsed["groups"] if g["courses"] or g["kind"] != "faculty"]
            if not args.no_areas and minor:
                # the lists are normally on the page; an area that came back empty (MKTG, ENTREP) has its own list page
                empty = [g for g in parsed["groups"] if g["kind"] in AREA_SUFFIX and not g["courses"]]
                if empty:
                    fill_area_courses(probe, entry_term, program, empty, args.delay, parsed.get("links"))
            if not args.no_areas and not minor:
                fill_area_courses(probe, entry_term, program, parsed["groups"], args.delay,
                                  parsed.get("links"))
                if is_dm:
                    took = borrow_from_major(parsed["groups"], program, entry_term, out_dir)
                    if took:
                        print(f"    no double-major list found for {', '.join(took)} — using {base_of(program)}'s own")
            entry = {"groups": parsed["groups"], "credits": parsed["credits"],
                     "totalCredits": parsed["totalCredits"], "totalEcts": parsed["totalEcts"], "source": url}
            put_entry(store, hashes, entry_term, entry)
            if parsed["title"] and store["name"] == program:
                store["name"] = minor_name(parsed["title"], program) if minor else parsed["title"]
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
