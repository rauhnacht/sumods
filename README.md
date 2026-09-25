# SUMods

A NUSMods-style timetable planner for Sabancı University. It reads the public BannerWeb
class schedule, so you can search courses, drag your week into shape by tapping a class to
see its other slots, catch clashes before registration, and copy the CRNs into BannerWeb's
add/drop worksheet.

```
index.html      the whole app (vanilla JS, no build step)
app.css
app.js
data/           terms.json, one file per term, plus <term>-info.json descriptions
scraper/scrape.py    BannerWeb schedule scraper
scraper/details.py   syllabus + course-catalog descriptions, prerequisites
scraper/exams.py     final exam schedule
scraper/academic_calendar.py  academic calendar: term dates, registration and add/drop days, days off
scraper/programs.py  degree requirements per programme and entry term
tools/build_catalog.py  one file listing every course across the archive
tools/import_suchedule.py  seeds schedule data from SUchedule's public snapshot
tools/import_program.py    turns a curriculum table into a planner programme
build_standalone.py  bundles everything into dist/sumods.html (single file, works offline)
build_pages.py       pre-renders /courses/<CODE>/ pages + sitemap.xml for search engines
sw.js, manifest.webmanifest, icons/   installable, offline-capable PWA
config.js            deployment settings (live seats endpoint)
worker/              optional live seats service (Cloudflare Worker)
scraper/seats.py     seat availability per CRN
```

## What it does

- **Timetable** — search by course code, title or instructor; tap any class to see the other
  time slots that section is taught in and switch with one more tap. Dashed red outlines mark
  slots that would clash with something you already have.
- **Section linking** — Sabancı ties lecture group B to recitation groups B1, B2… for some
  courses but not all. SUMods treats it as the default, not a rule: changing the lecture moves
  the recitation with it, non-matching groups stay selectable under "Other lecture groups",
  and picking one shows a note to check BannerWeb. The arranger prefers matched pairs.
- **Optimiser** — goes through every valid section combination of the courses in your
  timetable and ranks the best six against what you ask for: no class before X, done by Y,
  lunch kept free, fewer days on campus, fewer gaps, a specific day clear, lectures locked.
  Each option shows what it costs you ("Fri not free", "early start"); nothing changes until
  you pick one, and Undo puts it back.
- **Plan** — a degree plan built from the terms you add (any Fall/Spring/Summer, past or
  future): courses per term, credits and term GPA, editable grades, a running CGPA, a warning
  when something sits before its prerequisite or in a term it isn't usually offered in, and
  progress against the programme's requirement groups. Pick a **double major** alongside the
  primary programme and both track independently, side by side. Click a requirement card to
  see exactly which of your courses filled it — and, when a course is standing in for another
  under a transitional rule, what it's counted in place of. Programmes come from
  `data/programs/`; `data/programs/overrides.json` holds hand-maintained corrections (like an
  either/or between two courses during a curriculum transition) that survive re-scraping.
- **Import transcript** — open your BannerWeb *Academic Records Summary* (saved as HTML, or
  printed to PDF) and the plan fills itself in: every term, course, credit, ECTS and grade.
  The file is read inside the browser tab — it is never uploaded, and the name and student
  number on it are not parsed. PDFs are read with pdf.js loaded from cdnjs on demand.
- **Registration days** — pick your programme (and double major) and the table under the
  timetable says which day of registration each course opens for you, with its CRNs, plus the
  critical (`*`) and class-restriction (`!`) marks from the published list. The CRN window
  groups the codes by day so you can work through registration in order.
- **Seats** — capacity and remaining seats per section in the course panel, the section
  pickers, the CRN list and the registration table; a full section you picked gets a warning,
  and the auto-picker and optimiser steer around full sections. With the optional live
  service, opening a course panel refreshes its seats straight from BannerWeb.
- **CRNs** — a tap-to-copy list, since the add/drop worksheet takes CRNs one box at a time.
  Paste a friend's CRN list to load their timetable, or share a link.
- **Prerequisite graph** — the course panel draws what a course needs first (two levels
  back, alternatives dashed) and what it opens up; every box is clickable. Built from the
  prerequisite text `details.py` parses into codes.
- **Workload** — weekly class hours per lecture/recitation/lab straight from the schedule,
  plus a self-study estimate from ECTS (25–30 hours per ECTS over a ~14-week term).
- **Archive** — every term back to Fall 2018 in the term picker, and each course panel says
  when the course has run ("every fall since 2018; Spring '20").
- **Your own events** — club meetings, a job, the gym: they sit in the timetable, count in
  clash checks and the optimiser, and go into the calendar file and the image.
- **Finals** — exam dates sit next to the timetable in date order, overlapping finals are
  flagged, and each course panel shows its own exam.
- **Add to calendar** — exports an .ics with one repeating event per class in Europe/Istanbul
  time, skipping the days off in the academic calendar, a one-off event per final, and
  registration-day reminders at 09:00 that list the CRNs due that day (plus add/drop).
- **Today** — what's on today in Istanbul time, with the class you're in highlighted, how long
  until the next one, and any exam that day.
- **Save as image** — the week as a PNG (SVG if the browser can't rasterise), CRNs along the
  bottom, for sending to whoever asks what your schedule looks like. `Ctrl/Cmd+P` prints a
  clean copy.
- **Installable and offline** — a web manifest and a service worker keep the app shell and the
  last course data cached, so it opens from the home screen without a connection.
- **Course details** — the ⓘ button on a course, or a row in the Courses tab, opens the
  description, ECTS, prerequisites, every section with its room and instructor, a link to
  each section's **syllabus**, the course catalog page, and the BannerWeb page where seat
  counts live.
- **Rooms** — every room, filterable by name; pick one to see its full weekly schedule.

Timetables are stored in the browser (localStorage), one per term. Nothing leaves the device.

## Running it

Any static server works, because the app only fetches `data/*.json`:

```bash
python scraper/scrape.py          # writes data/terms.json and data/<term>.json
python -m http.server 8000        # open http://localhost:8000
```

Single-file build (handy for sharing or offline use):

```bash
python build_standalone.py        # dist/sumods.html with data baked in
```

## The scraper

`scraper/scrape.py` walks the same three pages a student would:

1. `bwckschd.p_disp_dyn_sched` — the term list.
2. `bwckgens.p_proc_term_date` — the subject list for a term.
3. `bwckschd.p_get_crse_unsec` — every section of every subject, in one POST.

It parses the "Sections Found" page into course → component → section → meetings, keeping
CRNs, group codes, meeting days and times, rooms, instructors, SU credits and level. Building
names are shortened the way students write them (FENS, FASS, FMAN, SL, UC).

```bash
python scraper/scrape.py                    # the 3 most recent terms
python scraper/scrape.py --terms 202601     # one term (202601 = Fall 2026-2027)
python scraper/scrape.py --html saved.html --terms 202601   # parse a saved page
python scraper/tests/test_scrape.py         # parser tests against a fixture
```

Term codes are `YYYY01` Fall, `YYYY02` Spring, `YYYY03` Summer, with `YYYY` the starting year.

### Descriptions: `scraper/details.py`

Descriptions come from two places, in order: the section's syllabus
(`apps.sabanciuniv.edu/courses/syllabus/view.php?term=202601&sc=CS&cn=412&section=B&view=su`)
and, when that can't be read or has no description, the public course catalog
(`sabanciuniv.edu/en/aday-ogrenciler/lisans/ders-katalogu/course/CS-412`), which also carries
ECTS, SU credits, prerequisite and corequisite. Everything lands in `data/<term>-info.json`
and the site merges it on top of the schedule, so it is optional — without it the app just
links out instead of showing the text.

```bash
python scraper/details.py --limit 20            # try it on a few courses first
python scraper/details.py                       # whole term, skipping what's stored
python scraper/details.py --only "CS 412" --dump cs412.html   # save a page…
python scraper/details.py --html cs412.html     # …and see what the parsers pull out of it
python scraper/tests/test_details.py
```

The syllabus layout isn't public, so `details.py` reads it by label ("Course Description",
"Ders İçeriği", "Objectives", "Textbook"…) in both English and Turkish, over table rows and
running text alike. If a real page comes back with nothing, `--dump` plus `--html` shows what
the parsers saw; add the missing label to `FIELDS` in `details.py`.

### Data shape

`data/terms.json` lists the terms; each `data/<term>.json` holds the courses:

```jsonc
{
  "term": "202601", "name": "Fall 2026-2027", "updated": "2026-09-22T03:56:44Z",
  "places": ["FENS G077", ...], "people": ["Saima Gül", ...],
  "courses": [{
    "code": "CS 201", "title": "Programming Fundamentals", "credits": 4, "level": "UG",
    "components": [{
      "type": "", "label": "Lecture",
      "sections": [{ "crn": "10190", "group": "A", "people": [31],
                     "meetings": [[1, 520, 570, 36]] }]   // [day, start, end, place] in minutes
    }]
  }]
}
```

`type` is the suffix BannerWeb uses on the course code: `""` lecture, `R` recitation,
`L` lab, `D` discussion. Day 0 is Monday. A section with no timed meetings gets `"tba": 1`.

### Finals: `scraper/exams.py`

Reads BannerWeb's printable final exam listing
(`suis.sabanciuniv.edu/HbbmInst/P_FINAL_EXAM_SCHEDULE.p_print_shedule`) into
`data/<term>-exams.json`. It maps columns by their headers when the page has them and
otherwise recognises rows by shape — a course code, a date, a time range, a room — so it
survives the page being a plain printout. Midterms aren't published centrally, so they
aren't here.

```bash
python scraper/exams.py --dump exams.html    # save the page…
python scraper/exams.py --html exams.html    # …and see what the parser makes of it
```

### Registration days: `tools/import_regdays.py`

Before each registration period Sabancı publishes "Course Registration Days" — a table of
which programmes may register for which course on day 1, 2 or 3, with `*` for critical
courses and `( ! )` for a class restriction on every day. Feed it the PDF (or an HTML copy):

```bash
python tools/import_regdays.py CourseRegistrationDays.pdf --term 202601
```

The PDF is read in pypdf's layout mode so the three day columns stay apart, wrapped
programme lists are stitched back together, and the result lands in
`data/<term>-regdays.json`. Re-run it whenever a new list is issued; the date of issue is
stored and shown in the app, since courses opened later won't be on it.

### Seats: `scraper/seats.py` and `worker/seats-worker.js`

Seat counts live on BannerWeb's detailed class information page
(`bwckschd.p_disp_detail_sched?term_in=202601&crn_in=13602`), in its "Registration
Availability" table. A browser can't read that page from another site, so there are two ways
in:

- **The scraper** reads every CRN of the term into `data/<term>-seats.json`
  (`python scraper/seats.py`, rate limited to 4 requests a second). The `update-seats`
  workflow runs it every 30 minutes; with `--auto` it only does the full pass during
  registration and add/drop and once a day otherwise, so BannerWeb isn't hammered for a
  number nobody is watching.
- **The live service** is a Cloudflare Worker that fetches up to 12 CRNs on request, caches
  each for 60 seconds and answers with CORS headers:

  ```bash
  npx wrangler deploy worker/seats-worker.js --name sumods-seats
  ```

  Put its URL in `config.js` (`seatsEndpoint`). Opening a course panel then shows live seats
  and a Refresh button; without it the app shows the scraped file with its timestamp.

### Term dates: `scraper/academic_calendar.py`

Parses the academic calendar (`sabanciuniv.edu/tr/akademik-takvim?b=2026&c=16&d=tr`) into
`data/<term>-calendar.json`: when classes start and end, when finals run, and every official
day off. The .ics export uses these, and the days off become EXDATEs so a holiday doesn't
show up as a class. `--level` picks the column (LİSANS by default, LİSANSÜSTÜ for graduate
programmes, TGY for the Foundations year).

## Getting courses into Google

The planner itself is one page, which search engines have nothing to index. `build_pages.py`
pre-renders a static page per course — `/courses/EE310/` — with the title, description,
every section with its times, rooms, instructors and CRNs, schema.org `Course` markup, and a
link that opens the course in the planner (`/#course/EE310/202601`). It also writes
`/courses/` as a crawlable index of every course, plus `sitemap.xml` and `robots.txt`.

```bash
python build_pages.py --base https://username.github.io/sumods
```

Pages are built for every term in `data/`, newest first, so a course that isn't running this
semester keeps the page of the last term it ran in, marked as such. The deploy workflow runs
this step automatically with the real site URL, so nothing is committed to the repo.

After the first deploy, add the site in Google Search Console and submit `/sitemap.xml`;
indexing takes days to weeks, and sabanciuniv.edu's own pages will compete for a query like
"sabancı ee 310". A custom domain helps more than anything else you can change on the page.

## Deploying

`.github/workflows/update-data.yml` does the scraping — it runs every four hours, commits
`data/` only when something changed, and stops there. Deploying the site is a separate
workflow, one of three, depending on where you're hosting:

- **`deploy-pages.yml`** — GitHub's own free hosting. Settings → Pages → Source: **GitHub
  Actions**, no secrets needed.
- **`deploy-ftp.yml`** — classic shared hosting (cPanel, Plesk, any host with FTP/FTPS).
  Add repo secrets `FTP_HOST`, `FTP_USERNAME`, `FTP_PASSWORD`, `SITE_URL` (Settings →
  Secrets and variables → Actions). If the FTP root isn't your public web folder, set
  `server-dir` in the workflow to the right path (e.g. `/public_html/`).
- **`deploy-ssh.yml`** — a VPS or anything reachable over SSH, via rsync. Add secrets
  `SSH_HOST`, `SSH_USER`, `SSH_KEY` (the private key; put the matching public key in the
  server's `authorized_keys`), `SSH_TARGET_DIR` (the site's public folder), `SITE_URL`.

Delete the two you don't need — each triggers automatically once `update-data.yml` finishes,
so only one should exist. Both hosting workflows build the indexable `/courses/` pages with
your real domain in `SITE_URL` before uploading.

Trigger `update-data.yml` by hand once from the Actions tab to pull real data, then trigger
your chosen deploy workflow the same way for the first upload; after that both run on their
own.

If a run fails because BannerWeb is unreachable from GitHub's runners, run
`python scraper/scrape.py` locally and push `data/` — everything else stays the same. Please
keep the schedule gentle; each run is a handful of requests.

### Degree requirements: `scraper/programs.py`

The course catalogue's degree pages (`SU_DEGREE.p_degree_detail` on BannerWeb, embedded in
sabanciuniv.edu's degree-detail page) list, per programme and **entry term**, a summary of
the areas — University Courses, Required, Core Electives, Area Electives, Free Electives —
with their minimum SU credits / ECTS / courses, and then each area's courses.

```bash
python scraper/programs.py                                   # all 12 programmes, entries since 2019
python scraper/programs.py --programs BSEE BSMAT --entries 202401
python scraper/programs.py --programs BSEE --entries 202401 --dump bsee.html
python scraper/programs.py --html bsee.html --programs BSEE --entries 202401
```

Output is `data/programs/<CODE>.json` (every entry term inside, identical ones stored once)
and `data/programs/index.json`. The planner then asks for programme + entry term — after a
transcript import it picks both itself — and counts courses the way the university does:
a course sits in the first area that lists it, core electives beyond the core minimum spill
into area electives, and anything else counts as a free elective. Seniors (94+ credits) see
their programme's required and core courses moved to day 1 in the registration table.

The page layout isn't documented, so the parser reads it by meaning — the summary row names,
headings that name an area, and course codes in the rows after them — whether the headings
are table rows, bold text or `<h4>`s. If a real page comes back empty, `--dump` + `--html`
shows what it saw.

### Manual corrections: `data/programs/overrides.json`

A degree page lists courses, not policy footnotes — something like "either EE 321 or CS 303
satisfies this requirement for now, but only EE 321 will count from a later entry cohort
onward" isn't machine-readable from the scraped table. `overrides.json` patches the scraped
requirements for exactly this kind of case, scoped to the entry terms it actually applies to,
so it naturally stops applying once a cohort ages out — no code change needed later:

```jsonc
{"overrides": [{
  "program": "BSEE", "group": "Required Courses",
  "replace": "EE 321", "with": ["EE 321", "CS 303"],
  "entries": { "from": "202301", "to": "202701" },
  "note": "Either course satisfies this for students who entered 202301–202701; EE 321 only from 202801."
}]}
```

`replace` is the course code as it appears in the scraped group; `with` becomes the new
either/or slot (any one of those courses fills it — the requirement panel shows which one a
student actually used, and what it substituted for). `entries.from`/`to` are inclusive and
either can be omitted for an open-ended range. This file is never touched by
`scraper/programs.py`, so it survives every re-scrape. The shipped entry is a real EE example
with a placeholder `to` — adjust it once the official cutoff term is confirmed.

### Programmes by hand: `tools/import_program.py`

The planner reads `data/programs.json`. Each programme is a list of requirement groups, plus
an optional year-by-year suggested plan:

```jsonc
{"programs": [{
  "id": "EE-BS-2026", "name": "Electronics Engineering (BSc)", "catalog": "2026",
  "groups": [
    {"name": "University courses", "courses": ["SPS 101", "HIST 191"]},
    {"name": "Area electives", "credits": 21, "match": "EE (3|4)\\d{2}", "creditsEach": 3},
    {"name": "Free electives", "credits": 12, "any": true, "creditsEach": 3}
  ],
  "suggested": {"1F": ["MATH 101", "NS 101"], "1S": ["MATH 102"]}
}]}
```

A group is satisfied by its listed `courses`, by a code `match` pattern for electives, or by
`any` course; `credits` or `choose` says how much of it is needed. Rather than writing that by
hand, feed a curriculum table to the importer — CSV/TSV, or an HTML table saved from wherever
the curriculum lives:

```bash
python tools/import_program.py ee.csv --id EE-BS-2026 --name "Electronics Engineering (BSc)"
python tools/import_program.py curriculum.html --html --id MAT-BS-2026 --name "Materials Science"
```

Columns (`group, code, credits, year, term`, header names matched loosely in English or
Turkish) may be in any order; `year` + `term` become the suggested plan. A row with a group
but no course code states that group's own credit requirement.

## Still missing

- **Degree Evaluation import** — the SIS page that shows what the registrar has already counted
  where. Needs a saved copy of that page to write the parser against.

- Midterms: not published centrally, so only finals are here.
- Workload and grading breakdowns beyond whatever a syllabus page happens to list.

## Notes and limits

- Seat counts, prerequisites, quotas and same-day changes are not in this data. BannerWeb's
  section page (linked from every CRN) is the source of truth before you register.
- `tools/import_suchedule.py` converts a [SUchedule](https://github.com/aburakayaz/suchedule)
  data file into this schema. That data has no credit values and rounds times to standard SU
  slots, so run the scraper for the full picture.
- Not affiliated with Sabancı University.
