#!/usr/bin/env python3
"""
Pre-render one static page per course so search engines can index them, the way
NUSMods has a page per module.

  /courses/                 every course in the term, grouped by subject (crawl hub)
  /courses/EE310/           EE 310: description, sections, times, rooms, CRNs, syllabus links
  /sitemap.xml, /robots.txt

Each page is plain HTML — no JavaScript needed to read it — and links into the app at
/#course/EE310/202601, which opens that course's panel.

  python build_pages.py --base https://username.github.io/sumods
  python build_pages.py --term 202601 --out .
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
BANNER = "https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_detail_sched?term_in={term}&crn_in={crn}"
SYLLABUS = ("https://apps.sabanciuniv.edu/courses/syllabus/view.php"
            "?term={term}&sc={subj}&cn={num}&section={section}&view=su")
CATALOG = "https://www.sabanciuniv.edu/en/aday-ogrenciler/{level}/ders-katalogu/course/{subj}-{num}"

e = html.escape


def hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def slug(code: str) -> str:
    return code.replace(" ", "")


def catalog_url(subj: str, num: str) -> str:
    return CATALOG.format(level="lisansustu" if num[:1] >= "5" else "lisans", subj=subj, num=num)


def lecture_of(course: dict) -> dict:
    return next((c for c in course["components"] if c["type"] == ""), course["components"][0])


def meeting_text(section: dict, places: list[str]) -> str:
    if not section["meetings"]:
        return "TBA"
    return "<br>".join(
        e(f'{DAYS[m[0]]} {hhmm(m[1])}–{hhmm(m[2])}') for m in section["meetings"])


def room_text(section: dict, places: list[str]) -> str:
    rooms = [places[m[3]] for m in section["meetings"] if m[3] >= 0 and places[m[3]]]
    return "<br>".join(e(r) for r in dict.fromkeys(rooms)) or "—"


def summary_line(course: dict, term_name: str) -> str:
    """One sentence used as the meta description when no catalog text exists."""
    bits = []
    for comp in course["components"]:
        bits.append(f'{len(comp["sections"])} {(comp.get("label") or "section").lower()}'
                    f'{"s" if len(comp["sections"]) != 1 else ""}')
    return (f'{course["code"]} {course["title"]} at Sabancı University, {term_name}: '
            f'{", ".join(bits)} with meeting times, rooms, instructors and CRNs.')


def requirement_links(groups: list, known: set) -> str:
    parts = []
    for group in groups or []:
        codes = " or ".join(
            f'<a href="../{slug(c)}/">{e(c)}</a>' if c in known else e(c) for c in group)
        parts.append(codes)
    return "; ".join(parts)


def course_page(course: dict, term: str, term_name: str, updated: str, places: list[str],
                people: list[str], info: dict, base: str, stale_for: str = "",
                exams: list | None = None, known: set | None = None, opens: list | None = None) -> str:
    subj, num = course["code"].split(" ")
    code_slug = slug(course["code"])
    desc = info.get("desc", "")
    meta_desc = (desc or summary_line(course, term_name))[:300]
    url = f"{base}/courses/{code_slug}/" if base else f"/courses/{code_slug}/"

    facts = [term_name]
    if course.get("credits") is not None:
        facts.append(f'{course["credits"]} SU credits')
    if info.get("ects"):
        facts.append(f'{info["ects"]} ECTS')
    facts.append("Graduate" if course.get("level", "").startswith("GR") else "Undergraduate")

    tables = []
    for comp in course["components"]:
        rows = []
        for s in comp["sections"]:
            letter = re.match(r"^([A-Za-z]+)\d+$", s["group"])
            lecture_groups = {x["group"].upper() for x in lecture_of(course)["sections"]}
            syl_section = s["group"]
            syl_num = num + (comp["type"] or "")
            if comp["type"]:
                syl_num = num
                syl_section = (letter.group(1).upper() if letter and letter.group(1).upper() in lecture_groups
                               else lecture_of(course)["sections"][0]["group"])
            rows.append(f"""<tr>
      <td><b>{e(s["group"])}</b></td>
      <td>{meeting_text(s, places)}</td>
      <td>{room_text(s, places)}</td>
      <td>{e(", ".join(people[i] for i in s.get("people", []) if i < len(people))) or "—"}</td>
      <td><a href="{e(BANNER.format(term=term, crn=s["crn"]))}" rel="nofollow noopener" target="_blank">{e(s["crn"])}</a></td>
      <td><a href="{e(SYLLABUS.format(term=term, subj=subj, num=syl_num, section=syl_section))}" rel="nofollow noopener" target="_blank">syllabus</a></td>
    </tr>""")
        tables.append(f"""<h2>{e(comp.get("label") or "Sections")} — {e(course["code"] + comp["type"])}</h2>
  <table class="sec-table">
    <tr><th>Section</th><th>When</th><th>Where</th><th>Instructor</th><th>CRN</th><th></th></tr>
    {"".join(rows)}
  </table>""")

    extras = []
    for exam in (exams or []):
        when = f'{exam["date"]}'
        if exam.get("start") is not None:
            when += f' {hhmm(exam["start"])}'
            if exam.get("end"):
                when += f'–{hhmm(exam["end"])}'
        extras.append(f'<p class="detail-extra"><b>Final{" " + e(exam["section"]) if exam.get("section") else ""}</b> '
                      f'{e(when)}{", " + e(exam["place"]) if exam.get("place") else ""}</p>')
    known = known or set()
    prereq_html = requirement_links(info.get("prereqCodes"), known)
    coreq_html = requirement_links(info.get("coreqCodes"), known)
    if prereq_html:
        extras.append(f'<p class="detail-extra"><b>Needs first</b> {prereq_html}</p>')
    elif info.get("prereq"):
        extras.append(f'<p class="detail-extra"><b>Prerequisite</b> {e(info["prereq"])}</p>')
    if coreq_html:
        extras.append(f'<p class="detail-extra"><b>Alongside</b> {coreq_html}</p>')
    if opens:
        links = ", ".join(f'<a href="../{slug(c)}/">{e(c)}</a>' for c in opens)
        extras.append(f'<p class="detail-extra"><b>Opens up</b> {links}</p>')
    for label, key in (("Objectives", "objectives"),):
        if info.get(key):
            extras.append(f'<p class="detail-extra"><b>{label}</b> {e(info[key])}</p>')

    jsonld = {
        "@context": "https://schema.org",
        "@type": "Course",
        "name": f'{course["code"]} {course["title"]}',
        "courseCode": course["code"],
        "url": url,
        "description": meta_desc,
        "inLanguage": "en",
        "provider": {"@type": "CollegeOrUniversity", "name": "Sabancı University",
                     "url": "https://www.sabanciuniv.edu/"},
    }

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(course["code"])} {e(course["title"])} — Sabancı course schedule</title>
<meta name="description" content="{e(meta_desc)}">
<link rel="canonical" href="{e(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(course["code"])} {e(course["title"])} — Sabancı University">
<meta property="og:description" content="{e(meta_desc)}">
<meta property="og:url" content="{e(url)}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap">
<link rel="stylesheet" href="../../app.css">
<style>
  .page {{ max-width: 860px; margin: 0 auto; padding: 18px max(14px, env(safe-area-inset-left)) 40px; }}
  .page h1 {{ font-size: 26px; letter-spacing: -.02em; margin: 6px 0 2px; }}
  .page h1 span {{ font-stretch: 84%; }}
  .page h2 {{ font-size: 15px; margin: 22px 0 6px; font-stretch: 86%; }}
  .crumb {{ font-size: 12.5px; color: var(--ink-3); }}
  .crumb a {{ color: inherit; }}
  .sec-table {{ width: 100%; }}
  .sec-table td, .sec-table th {{ padding: 5px 10px 5px 0; }}
  .tr-line {{ color: var(--ink-3); font-size: 12.5px; margin-top: 22px; }}
  .stale {{ background: var(--c2-bg); color: var(--c2-ink); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-weight: 600; margin: 8px 0 0; }}
</style>
<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False)}</script>
</head>
<body>
<main class="page">
  <p class="crumb"><a href="../../">SUMods</a> → <a href="../">Courses</a> → {e(course["code"])}</p>
  <h1><span>{e(course["code"])}</span> {e(course["title"])}</h1>
  <p class="detail-meta">{e(" · ".join(facts))}</p>
  {f'<p class="stale">Not in the {e(stale_for)} schedule — this is the most recent term it ran.</p>' if stale_for else ''}
  {f'<p class="detail-desc">{e(desc)}</p>' if desc else ''}
  {"".join(extras)}
  <div class="detail-links">
    <a class="btn primary" href="../../#course/{e(code_slug)}/{e(term)}">Open in the timetable planner</a>
    <a class="btn" href="{e(info.get("url") or catalog_url(subj, num))}" rel="nofollow noopener" target="_blank">Course catalog</a>
  </div>
  {"".join(tables)}
  <p class="tr-line">{e(course["code"])} — Sabancı Üniversitesi {e(term_name)} ders programı: section'lar, saatler, derslikler, CRN'ler ve syllabus bağlantıları.</p>
  <footer>Schedule read from Sabancı's public BannerWeb listing, updated {e(updated[:10])}.
  Seats and last-minute changes live in <a href="https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_dyn_sched" rel="nofollow noopener" target="_blank">BannerWeb</a>.
  Not affiliated with Sabancı University.</footer>
</main>
</body>
</html>
"""


def index_page(courses: list[dict], term: str, term_name: str, updated: str, base: str) -> str:
    by_subject: dict[str, list[dict]] = {}
    for c in courses:
        by_subject.setdefault(c["code"].split(" ")[0], []).append(c)
    blocks = []
    for subj in sorted(by_subject):
        items = "".join(
            f'<li><a href="{e(slug(c["code"]))}/"><b>{e(c["code"])}</b> {e(c["title"])}</a></li>'
            for c in by_subject[subj])
        blocks.append(f'<h2 id="{e(subj)}">{e(subj)}</h2><ul class="course-index">{items}</ul>')
    url = f"{base}/courses/" if base else "/courses/"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sabancı University courses, {e(term_name)} — SUMods</title>
<meta name="description" content="Every course Sabancı University offers in {e(term_name)}: sections, meeting times, rooms, instructors and CRNs.">
<link rel="canonical" href="{e(url)}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap">
<link rel="stylesheet" href="../app.css">
<style>
  .page {{ max-width: 900px; margin: 0 auto; padding: 18px max(14px, env(safe-area-inset-left)) 40px; }}
  .page h1 {{ font-size: 26px; letter-spacing: -.02em; margin: 6px 0 4px; }}
  .page h2 {{ font-size: 15px; margin: 24px 0 6px; font-stretch: 86%; }}
  .course-index {{ list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 28px; font-size: 14px; }}
  .course-index li {{ margin-bottom: 4px; break-inside: avoid; }}
  .course-index a {{ color: inherit; text-decoration: none; }}
  .course-index a:hover {{ text-decoration: underline; }}
  .crumb {{ font-size: 12.5px; color: var(--ink-3); }}
  @media (max-width: 620px) {{ .course-index {{ columns: 1; }} }}
</style>
</head>
<body>
<main class="page">
  <p class="crumb"><a href="../">SUMods</a> → Courses</p>
  <h1>Sabancı courses, {e(term_name)}</h1>
  <p class="detail-meta">{len(courses)} courses, read from BannerWeb on {e(updated[:10])}.
     <a href="../">Build your timetable →</a></p>
  {"".join(blocks)}
</main>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--term", help="term code; defaults to the newest in data/terms.json")
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--out", default=str(ROOT))
    ap.add_argument("--base", default="", help="site root, e.g. https://you.github.io/sumods")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    data_dir = Path(args.data)
    out = Path(args.out)
    index = json.loads((data_dir / "terms.json").read_text(encoding="utf-8"))
    term_codes = [args.term] if args.term else [t["code"] for t in index["terms"]]

    courses_dir = out / "courses"
    courses_dir.mkdir(parents=True, exist_ok=True)
    urls = [f"{base}/" if base else "/", f"{base}/courses/" if base else "/courses/"]

    # newest term first: a course keeps the page of the most recent term it ran in,
    # so a course missing this semester is still findable
    newest = None
    seen: set[str] = set()
    listed: list[dict] = []
    for term in term_codes:
        schedule = json.loads((data_dir / f"{term}.json").read_text(encoding="utf-8"))
        info_path = data_dir / f"{term}-info.json"
        info = json.loads(info_path.read_text(encoding="utf-8"))["courses"] if info_path.exists() else {}
        exams_path = data_dir / f"{term}-exams.json"
        exams_by_code: dict[str, list] = {}
        if exams_path.exists():
            for exam in json.loads(exams_path.read_text(encoding="utf-8")).get("exams", []):
                exams_by_code.setdefault(exam["code"], []).append(exam)
        known_codes = {c["code"] for c in schedule["courses"]}
        opens_up: dict[str, list[str]] = {}
        for code, entry in info.items():
            for group in entry.get("prereqCodes", []):
                for req in group:
                    opens_up.setdefault(req, []).append(code)
        if newest is None:
            newest = schedule
            listed = schedule["courses"]
        for course in schedule["courses"]:
            if course["code"] in seen:
                continue
            seen.add(course["code"])
            folder = courses_dir / slug(course["code"])
            folder.mkdir(exist_ok=True)
            (folder / "index.html").write_text(
                course_page(course, term, schedule["name"], schedule["updated"], schedule.get("places", []),
                            schedule.get("people", []), info.get(course["code"], {}), base,
                            "" if term == term_codes[0] else newest["name"],
                            exams_by_code.get(course["code"]), known_codes,
                            sorted(set(opens_up.get(course["code"], [])))),
                encoding="utf-8")
            urls.append(f'{base}/courses/{slug(course["code"])}/' if base else f'/courses/{slug(course["code"])}/')

    (courses_dir / "index.html").write_text(
        index_page(listed, newest["term"], newest["name"], newest["updated"], base), encoding="utf-8")

    today = dt.date.today().isoformat()
    sitemap = ["<?xml version='1.0' encoding='UTF-8'?>",
               "<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>"]
    for u in urls:
        sitemap.append(f"<url><loc>{e(u)}</loc><lastmod>{today}</lastmod></url>")
    sitemap.append("</urlset>")
    (out / "sitemap.xml").write_text("\n".join(sitemap), encoding="utf-8")
    (out / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n" if base else "User-agent: *\nAllow: /\n",
        encoding="utf-8")

    print(f"{len(seen)} course pages across {len(term_codes)} term(s) in {courses_dir}")
    if not base:
        print("note: pass --base https://you.github.io/repo so canonical URLs and the sitemap are absolute")


if __name__ == "__main__":
    main()
