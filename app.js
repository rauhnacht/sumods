/* SUMods — Sabancı University timetable planner.
   Plain ES2020, no build step. Data comes from scraper/scrape.py (BannerWeb). */

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const COLORS = 8;
const DAY_START = 8 * 60 + 40;
const DAY_END = 17 * 60 + 40;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/ı/g, 'i').replace(/İ/g, 'i');

const naturalKey = (s) => String(s).split(/(\d+)/).map((p) => (/^\d+$/.test(p) ? p.padStart(6, '0') : p)).join('');

function durText(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

/** The term code whose classes are running today (Istanbul date), independent of code sort
 * order — a future term can already be listed (and sorts higher) before its classes start. */
function activeTermCode(dateStr) {
  const [y, m] = (dateStr || istanbulToday()).split('-').map(Number);
  if (m >= 8) return `${y}01`;
  if (m <= 4) return `${y - 1}02`;
  return `${y - 1}03`;
}

/** Prefer the term actually in session; fall back to the newest listed if we have no data
 * for it (its schedule hasn't loaded/been scraped yet) or it isn't in the list at all. */
function defaultTermCode(terms) {
  const active = activeTermCode();
  return terms.some((t) => t.code === active) ? active : terms[0].code;
}

function istanbulToday() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function istanbulNow() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Istanbul', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const day = DAYS.indexOf(get('weekday'));
    const min = Number(get('hour')) % 24 * 60 + Number(get('minute'));
    return { day, min };
  } catch {
    const d = new Date();
    return { day: (d.getDay() + 6) % 7, min: d.getHours() * 60 + d.getMinutes() };
  }
}

/* ------------------------------------------------------------------- state */

const App = {
  index: null,        // terms.json
  raw: {},            // term code -> parsed term file
  idx: null,          // indexed current term
  swap: null,         // { code, type } while picking another slot
  preview: null,      // shared timetable being previewed
  undo: [],
  catalogLimit: 80,
  room: null,
};

const store = {
  term: null,
  view: 'timetable',
  prefs: { orientation: 'auto', theme: 'auto' },
  tts: {},
};

const STORAGE_KEY = 'sumods.v1';

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.assign(store, saved, { prefs: { ...store.prefs, ...saved.prefs } });
  } catch { /* first visit, or storage blocked */ }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* private mode */ }
  }, 120);
}

function tt(term = store.term) {
  if (App.preview && App.preview.term === term) return App.preview.tt;
  if (!store.tts[term]) store.tts[term] = { order: [], courses: {} };
  return store.tts[term];
}
const entry = (code) => tt().courses[code];
const readonlyMode = () => !!App.preview;

/* -------------------------------------------------------------- data loading */

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const loadIndex = () => (window.SUMODS_DATA ? Promise.resolve(window.SUMODS_DATA.index) : fetchJSON('data/terms.json'));

/** Descriptions, ECTS and syllabus links written by scraper/details.py. Optional. */
async function loadInfo(code) {
  if (window.SUMODS_DATA) return (window.SUMODS_DATA.info || {})[code] || null;
  try {
    return await fetchJSON(`data/${code}-info.json`);
  } catch {
    return null;
  }
}

/** Programme list: scraped requirements (data/programs/index.json) or a hand-made programs.json. */
async function loadPrograms() {
  const embedded = window.SUMODS_DATA;
  if (embedded && embedded.programIndex) return embedded.programIndex.programs || [];
  if (!embedded) {
    try {
      return (await fetchJSON('data/programs/index.json')).programs || [];
    } catch { /* fall through to the hand-made file */ }
  }
  const legacy = embedded ? { programs: embedded.programs || [] } : await fetchJSON('data/programs.json').catch(() => ({ programs: [] }));
  return (legacy.programs || []).map((p) => ({ code: p.id, name: p.name, entries: ['any'], legacy: p }));
}

/** Requirements for one programme and entry term, following "same as" links. */
async function loadRequirements(code, entryTerm) {
  const listed = (App.programs || []).find((p) => p.code === code);
  if (!listed) return null;
  if (listed.legacy) return { ...listed.legacy, code, entry: 'any' };
  let file = (App.programFiles || (App.programFiles = {}))[code];
  if (!file) {
    file = window.SUMODS_DATA ? (window.SUMODS_DATA.programFiles || {})[code]
      : await fetchJSON(`data/programs/${code}.json`).catch(() => null);
    if (!file) return null;
    App.programFiles[code] = file;
  }
  const entries = file.entries || {};
  let term = entryTerm && entries[entryTerm] ? entryTerm : Object.keys(entries).sort().reverse()[0];
  let entry = entries[term];
  for (let hop = 0; entry && entry.sameAs && hop < 20; hop += 1) entry = entries[entry.sameAs];
  if (!entry) return null;
  return { code, name: file.name, entry: term, ...entry };
}

const courseInfo = (code) => (App.info && App.info.courses ? App.info.courses[code] || null : null);

/** Term dates and days off from scraper/calendar.py. Optional. */
async function loadSide(code, kind) {
  if (window.SUMODS_DATA) return (window.SUMODS_DATA[kind] || {})[code] || null;
  try {
    return await fetchJSON(`data/${code}-${kind}.json`);
  } catch {
    return null;
  }
}

const LIVE_SEATS = ((window.SUMODS_CONFIG || {}).seatsEndpoint || '').replace(/\/$/, '');

/** [capacity, taken, remaining, …waitlist] for a CRN — live if we asked, else the scraped file. */
function seatInfo(crn) {
  const live = App.liveSeats && App.liveSeats[crn];
  const row = live ? live.row : App.seats && App.seats.seats ? App.seats.seats[crn] : null;
  if (!row) return null;
  return { capacity: row[0], taken: row[1], remaining: row[2], waitRemaining: row[5] ?? null, live: !!live };
}

function seatBadge(crn) {
  const s = seatInfo(crn);
  if (!s) return '';
  const cls = s.remaining <= 0 ? 'full' : s.remaining <= 5 ? 'low' : 'ok';
  const text = s.remaining <= 0 ? `full (${s.capacity})` : `${s.remaining}/${s.capacity} left`;
  return `<span class="seat ${cls}" title="${s.taken} of ${s.capacity} taken${s.waitRemaining ? `, ${s.waitRemaining} waitlist places` : ''}">${esc(text)}</span>`;
}

function seatsStamp() {
  const lives = Object.values(App.liveSeats || {});
  const time = lives.length ? lives.map((l) => l.at).sort().pop() : App.seats && App.seats.updated;
  if (!time) return '';
  const t = new Date(time);
  return `${lives.length ? 'live' : 'seats'} as of ${t.toLocaleString('en-GB', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

async function refreshSeats(crns) {
  if (!LIVE_SEATS || !crns.length) return false;
  try {
    const res = await fetch(`${LIVE_SEATS}/?term=${App.idx.term}&crns=${crns.slice(0, 12).join(',')}`);
    const body = await res.json();
    Object.entries(body.seats || {}).forEach(([crn, row]) => {
      if (row) App.liveSeats[crn] = { row, at: body.updated };
    });
    return true;
  } catch {
    return false;
  }
}

/** Finals for one course+section, from scraper/exams.py. */
function examFor(sec) {
  if (!App.exams) return null;
  const list = App.exams.byCrn.get(sec.crn);
  if (list) return list;
  const byCode = App.exams.byCode.get(sec.course.code) || [];
  return byCode.find((x) => !x.section || x.section.toUpperCase() === sec.group.toUpperCase())
    || (byCode.length === 1 ? byCode[0] : null);
}

function indexExams(raw) {
  const idx = { byCrn: new Map(), byCode: new Map(), list: raw && raw.exams ? raw.exams : [], updated: raw && raw.updated };
  for (const exam of idx.list) {
    if (exam.crn) idx.byCrn.set(String(exam.crn), exam);
    if (!idx.byCode.has(exam.code)) idx.byCode.set(exam.code, []);
    idx.byCode.get(exam.code).push(exam);
  }
  return idx;
}

/** Exams of the courses in the timetable, in date order, with overlaps flagged. */
function examPlan() {
  const rows = [];
  for (const sec of selectedSections()) {
    if (sec.component.type !== '') continue;
    const exam = examFor(sec);
    if (exam && exam.date) rows.push({ exam, sec });
  }
  rows.sort((a, b) => (a.exam.date + a.exam.start).localeCompare?.(b.exam.date + b.exam.start)
    || a.exam.date.localeCompare(b.exam.date) || (a.exam.start || 0) - (b.exam.start || 0));
  const clashes = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i].exam, b = rows[j].exam;
      if (a.date !== b.date) continue;
      const overlap = a.start === null || b.start === null
        || (a.start < (b.end ?? b.start + 120) && b.start < (a.end ?? a.start + 120));
      if (overlap) { clashes.add(i); clashes.add(j); }
    }
  }
  return { rows, clashes };
}

const fmtDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

/** [[ 'MATH 201', 'MATH 204' ], [ 'CS 201' ]] — groups are required, codes inside are alternatives. */
function requirementGroups(code, key = 'prereqCodes') {
  const info = courseInfo(code);
  return (info && info[key]) || [];
}

/** Courses in this term whose prerequisites name `code`. */
function unlockedBy(code) {
  if (!App.info || !App.info.courses) return [];
  const out = [];
  for (const [other, info] of Object.entries(App.info.courses)) {
    if (other === code || !App.idx.byCode.has(other)) continue;
    if ((info.prereqCodes || []).some((group) => group.includes(code))) out.push(other);
  }
  return out.sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));
}

/** The chain behind a course, depth-limited and cycle-safe. */
function prereqTree(code, depth = 2, seen = new Set()) {
  if (depth <= 0 || seen.has(code)) return [];
  seen.add(code);
  return requirementGroups(code).map((group) => ({
    alternatives: group.map((req) => ({ code: req, known: App.idx.byCode.has(req), needs: prereqTree(req, depth - 1, seen) })),
  }));
}

function prereqHTML(code) {
  const groups = prereqTree(code);
  const unlocks = unlockedBy(code);
  const coreq = requirementGroups(code, 'coreqCodes');
  if (!groups.length && !unlocks.length && !coreq.length) return '';

  const branch = (node) => `<li><button type="button" class="req${node.known ? '' : ' req-off'}" data-course="${esc(node.code)}">${esc(node.code)}</button>
    ${node.needs.length ? `<ul class="req-list">${node.needs.map(groupHTML).join('')}</ul>` : ''}</li>`;
  const groupHTML = (group) => group.alternatives.length > 1
    ? `<li><span class="req-or">one of</span><ul class="req-list">${group.alternatives.map(branch).join('')}</ul></li>`
    : branch(group.alternatives[0]);

  return `<div class="reqs">
    ${groups.length ? `<h3>Needs first</h3><ul class="req-list">${groups.map(groupHTML).join('')}</ul>` : ''}
    ${coreq.length ? `<h3>Alongside</h3><ul class="req-list">${coreq.map((g) => g.map((c) =>
      `<li><button type="button" class="req" data-course="${esc(c)}">${esc(c)}</button></li>`).join('')).join('')}</ul>` : ''}
    ${unlocks.length ? `<h3>Opens up</h3><p class="req-opens">${unlocks.map((c) =>
      `<button type="button" class="req" data-course="${esc(c)}">${esc(c)}</button>`).join(' ')}</p>` : ''}
  </div>`;
}

function syllabusURL(course, comp, group) {
  let num = course.num + (comp && comp.type ? comp.type : '');
  let section = group;
  // syllabi are published per lecture section, so a recitation points at its lecture
  if (comp && comp.type && course.lecture && course.lecture.sections.length) {
    const letter = linkLetter(group);
    num = course.num;
    section = letter && course.lectureGroups.has(letter) ? letter : course.lecture.sections[0].group;
  }
  const stored = courseInfo(course.code);
  if (stored && stored.syllabus && stored.syllabus[section]) return stored.syllabus[section];
  return `https://apps.sabanciuniv.edu/courses/syllabus/view.php?term=${encodeURIComponent(App.idx.term)}`
    + `&sc=${encodeURIComponent(course.subj)}&cn=${encodeURIComponent(num)}`
    + `&section=${encodeURIComponent(section)}&view=su`;
}

function catalogURL(course) {
  const stored = courseInfo(course.code);
  if (stored && stored.url) return stored.url;
  const level = course.num[0] >= '5' ? 'lisansustu' : 'lisans';
  return `https://www.sabanciuniv.edu/en/aday-ogrenciler/${level}/ders-katalogu/course/${course.subj}-${course.num}`;
}

const bannerURL = (crn) => `https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_detail_sched?term_in=${App.idx.term}&crn_in=${crn}`;

async function loadTerm(code) {
  if (App.raw[code]) return App.raw[code];
  const data = window.SUMODS_DATA ? window.SUMODS_DATA.terms[code] : await fetchJSON(`data/${code}.json`);
  if (!data) throw new Error(`No data for ${code}`);
  App.raw[code] = data;
  return data;
}

function indexTerm(raw) {
  const idx = {
    term: raw.term, name: raw.name, updated: raw.updated, source: raw.source,
    places: raw.places || [], people: raw.people || [],
    courses: [], byCode: new Map(), byCrn: new Map(), subjects: new Map(), rooms: new Map(),
  };

  for (const c of raw.courses) {
    const [subj, num] = c.code.split(' ');
    const course = {
      code: c.code, title: c.title, credits: c.credits ?? null, subj, num,
      level: c.level || (/^[0-4]/.test(num) ? 'UG' : 'GR'),
      components: [], lectureGroups: new Set(), lecture: null,
    };
    for (const comp of c.components) {
      const component = { type: comp.type, label: comp.label || '', code: c.code + comp.type, sections: [], course };
      for (const s of comp.sections) {
        const meetings = (s.meetings || []).map((m) => ({
          day: m[0], start: m[1], end: m[2], place: m[3] >= 0 ? (idx.places[m[3]] || '') : '',
        }));
        const sec = {
          crn: String(s.crn), group: s.group, course, component, meetings,
          people: (s.people || []).map((i) => idx.people[i]).filter(Boolean),
          tba: !!s.tba || meetings.length === 0,
          sig: meetings.map((m) => `${m.day}:${m.start}-${m.end}`).sort().join(','),
        };
        component.sections.push(sec);
        idx.byCrn.set(sec.crn, sec);
        for (const m of meetings) {
          if (!m.place) continue;
          for (const place of m.place.split(' / ')) {
            if (!idx.rooms.has(place)) idx.rooms.set(place, []);
            idx.rooms.get(place).push({ sec, m });
          }
        }
      }
      if (comp.type === '') {
        course.lecture = component;
        component.sections.forEach((s) => course.lectureGroups.add(s.group.toUpperCase()));
      }
      course.components.push(component);
    }
    course.foldCode = fold(course.code.replace(/\s+/g, ''));
    course.foldTitle = fold(course.title);
    course.foldPeople = fold([...new Set(course.components.flatMap((cp) => cp.sections.flatMap((s) => s.people)))].join(' '));
    course.instructors = [...new Set((course.lecture || course.components[0]).sections.flatMap((s) => s.people))];
    idx.courses.push(course);
    idx.byCode.set(course.code, course);
    idx.subjects.set(subj, (idx.subjects.get(subj) || 0) + 1);
  }
  return idx;
}

/* ------------------------------------------------------- timetable model */

function linkLetter(group) {
  const m = /^([A-Za-z]+)\d+$/.exec(group || '');
  return m ? m[1].toUpperCase() : null;
}

/** Sabancı links a lecture group to its lettered recitation/lab groups: lecture B takes B1, B2… */
function compatible(course, lectureSec, sec) {
  if (!lectureSec || sec.component.type === '') return true;
  const letter = linkLetter(sec.group);
  if (!letter || !course.lectureGroups.has(letter)) return true;
  return lectureSec.group.toUpperCase() === letter;
}

function compatibleSections(course, comp, lectureSec) {
  if (comp.type === '') return comp.sections;
  const list = comp.sections.filter((s) => compatible(course, lectureSec, s));
  return list.length ? list : comp.sections;
}

/** Components whose groups are lettered after the lecture groups (B -> B1, B2…). */
function componentLinks(course, comp) {
  return comp.type !== '' && comp.sections.some((s) => {
    const letter = linkLetter(s.group);
    return letter && course.lectureGroups.has(letter);
  });
}

function comboPenalty(course, sections) {
  const lecture = sections.find((s) => s.component.type === '');
  if (!lecture) return 0;
  let bad = 0;
  for (const s of sections) {
    if (s.component.type === '') continue;
    if (!componentLinks(course, s.component)) continue;
    if (linkLetter(s.group) !== lecture.group.toUpperCase()) bad += 1;
  }
  return bad;
}

function dedupeBySig(sections, preferredCrn) {
  const groups = new Map();
  for (const s of sections) {
    if (!groups.has(s.sig)) groups.set(s.sig, []);
    groups.get(s.sig).push(s);
  }
  return [...groups.values()].map((g) => g.find((s) => s.crn === preferredCrn) || g[0]);
}

/** Every valid section combination for one course (deduplicated by meeting pattern). */
function courseCombos(course, opts = {}) {
  const current = opts.current || {};
  const limit = opts.limit || 3000;
  const lectureComp = course.lecture;
  let lectures = [null];
  if (lectureComp) {
    lectures = dedupeBySig(lectureComp.sections, current['']);
    if (opts.keepLecture && current[''] && lectureComp.sections.some((s) => s.crn === current[''])) {
      lectures = [lectureComp.sections.find((s) => s.crn === current[''])];
    }
  }
  const others = course.components.filter((c) => c.type !== '');
  const combos = [];
  for (const lec of lectures) {
    const lists = others.map((comp) => dedupeBySig(compatibleSections(course, comp, lec), current[comp.type]));
    const walk = (i, picked) => {
      if (combos.length >= limit) return;
      if (i === lists.length) {
        const sections = (lec ? [lec] : []).concat(picked);
        const sel = {};
        sections.forEach((s) => { sel[s.component.type] = s.crn; });
        combos.push({
          sel, sections, meetings: sections.flatMap((s) => s.meetings),
          penalty: comboPenalty(course, sections),
          full: sections.filter((s) => { const seat = seatInfo(s.crn); return seat && seat.remaining <= 0; }).length,
        });
        return;
      }
      for (const s of lists[i]) walk(i + 1, picked.concat(s));
    };
    walk(0, []);
  }
  return combos;
}

function overlapMinutes(a, b) {
  if (a.day !== b.day) return 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function clashMinutes(meetings, occupied) {
  let total = 0;
  for (const m of meetings) for (const o of occupied) total += overlapMinutes(m, o);
  return total;
}

function occupiedMeetings(excludeCode) {
  const out = customMeetings();
  for (const code of tt().order) {
    const e = tt().courses[code];
    if (!e || e.hidden || code === excludeCode) continue;
    const course = App.idx.byCode.get(code);
    if (!course) continue;
    for (const comp of course.components) {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      if (sec) out.push(...sec.meetings);
    }
  }
  return out;
}

/** Pick the combination of sections for one course that clashes least with everything else. */
function bestCombo(course, opts = {}) {
  const combos = courseCombos(course, opts);
  const occupied = opts.occupied || occupiedMeetings(course.code);
  let best = null, bestScore = Infinity;
  combos.forEach((cb, i) => {
    const score = clashMinutes(cb.meetings, occupied) * 100 + cb.penalty * 100000 + cb.full * 1000000 + i;
    if (score < bestScore) { best = cb; bestScore = score; }
  });
  return best || { sel: {} };
}

function nextColor() {
  const used = new Set(Object.values(tt().courses).map((c) => c.color));
  for (let i = 0; i < COLORS; i += 1) if (!used.has(i)) return i;
  return tt().order.length % COLORS;
}

function pushUndo(label) {
  if (readonlyMode()) return;
  App.undo.push({ label, snapshot: JSON.stringify(tt()) });
  if (App.undo.length > 12) App.undo.shift();
}

function undo() {
  const last = App.undo.pop();
  if (!last) return;
  store.tts[store.term] = JSON.parse(last.snapshot);
  App.swap = null;
  save();
  render();
}

function addCourse(code) {
  const course = App.idx.byCode.get(code);
  if (!course || entry(code)) return;
  pushUndo(`add ${code}`);
  const t = tt();
  t.courses[code] = { color: nextColor(), hidden: false, sel: {} };
  t.order.push(code);
  t.courses[code].sel = bestCombo(course).sel;
  save();
  render();
  toast(`${code} added`, { action: 'Undo', onAction: undo });
}

function removeCourse(code) {
  if (!entry(code)) return;
  pushUndo(`remove ${code}`);
  const t = tt();
  delete t.courses[code];
  t.order = t.order.filter((c) => c !== code);
  if (App.swap && App.swap.code === code) App.swap = null;
  save();
  render();
  toast(`${code} removed`, { action: 'Undo', onAction: undo });
}

function selectSection(code, type, crn, { quiet = false } = {}) {
  const course = App.idx.byCode.get(code);
  const e = entry(code);
  if (!course || !e) return;
  pushUndo(`change ${code}`);
  e.sel[type] = crn;
  const moved = [];
  if (type === '') {
    const lecture = App.idx.byCrn.get(crn);
    for (const comp of course.components) {
      if (comp.type === '') continue;
      const cur = App.idx.byCrn.get(e.sel[comp.type]);
      if (cur && compatible(course, lecture, cur)) continue;
      const options = compatibleSections(course, comp, lecture);
      const occupied = occupiedMeetings(code).concat(lecture ? lecture.meetings : []);
      let pick = options[0], pickScore = Infinity;
      options.forEach((s, i) => {
        const score = clashMinutes(s.meetings, occupied) * 100 + i;
        if (score < pickScore) { pick = s; pickScore = score; }
      });
      if (pick) { e.sel[comp.type] = pick.crn; moved.push(`${comp.code} ${pick.group}`); }
    }
  }
  save();
  render();
  if (!quiet) {
    const sec = App.idx.byCrn.get(crn);
    const extra = moved.length ? ` — ${moved.join(', ')} moved to match` : '';
    toast(`${sec.component.code} ${sec.group}${extra}`, { action: 'Undo', onAction: undo });
  }
}

function customEvents() {
  const t = tt();
  if (!t.custom) t.custom = [];
  return t.custom;
}

function customMeetings() {
  return customEvents().filter((ev) => !ev.hidden).map((ev) => ({ day: ev.day, start: ev.start, end: ev.end, place: ev.place || '' }));
}

function planBlocks({ includeHidden = false } = {}) {
  const blocks = [];
  customEvents().forEach((ev) => {
    if (ev.hidden && !includeHidden) return;
    blocks.push({
      id: `c:${ev.id}`, kind: 'custom', day: ev.day, start: ev.start, end: ev.end,
      color: ev.color ?? 7, code: ev.title || 'Event', group: '', where: ev.place || '',
      crn: `custom-${ev.id}`, courseCode: null, type: null, custom: ev, cls: 'custom',
    });
  });
  for (const code of tt().order) {
    const e = tt().courses[code];
    const course = App.idx.byCode.get(code);
    if (!e || !course || (e.hidden && !includeHidden)) continue;
    for (const comp of course.components) {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      if (!sec) continue;
      sec.meetings.forEach((m, i) => {
        blocks.push({
          id: `s:${sec.crn}:${i}`, kind: 'sel', day: m.day, start: m.start, end: m.end,
          color: e.color, code: comp.code, group: sec.group, where: m.place,
          crn: sec.crn, courseCode: code, type: comp.type, sec,
        });
      });
    }
  }
  return blocks;
}

function computeClashes(blocks) {
  const byDay = new Map();
  blocks.forEach((b) => {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  });
  const ids = new Set();
  const pairs = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (list[j].start >= list[i].end) break;
        if (list[i].crn === list[j].crn) continue;
        ids.add(list[i].id); ids.add(list[j].id);
        pairs.push([list[i], list[j]]);
      }
    }
  }
  return { ids, pairs };
}

function selectedSections({ includeHidden = false } = {}) {
  const out = [];
  for (const code of tt().order) {
    const e = tt().courses[code];
    const course = App.idx.byCode.get(code);
    if (!e || !course || (e.hidden && !includeHidden)) continue;
    for (const comp of course.components) {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      if (sec) out.push(sec);
    }
  }
  return out;
}

/* --------------------------------------------------------------- grid render */

function axisRange(blocks) {
  let start = DAY_START, end = DAY_END;
  blocks.forEach((b) => { start = Math.min(start, b.start); end = Math.max(end, b.end); });
  start = 40 + 60 * Math.floor((start - 40) / 60);
  end = 40 + 60 * Math.ceil((end - 40) / 60);
  return [Math.min(start, DAY_START), Math.max(end, DAY_END)];
}

function laneLayout(blocks, clustered) {
  const sorted = blocks.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const lanes = [];
  const result = [];
  let cluster = [];
  let clusterEnd = -1;

  const flush = () => {
    const total = Math.max(1, cluster.reduce((n, x) => Math.max(n, x.lane + 1), 0));
    cluster.forEach((x) => { x.lanes = total; });
    cluster = [];
    lanes.length = 0;
    clusterEnd = -1;
  };

  for (const b of sorted) {
    if (clustered && cluster.length && b.start >= clusterEnd) flush();
    let lane = lanes.findIndex((end) => end <= b.start);
    if (lane === -1) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = b.end;
    const item = { block: b, lane, lanes: 1 };
    cluster.push(item);
    result.push(item);
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  if (clustered) flush();
  else {
    const total = Math.max(1, result.reduce((n, x) => Math.max(n, x.lane + 1), 0));
    result.forEach((x) => { x.lanes = total; });
  }
  return result;
}

function blockBody(b, size) {
  const cls = ['blk', `c${b.color}`, b.cls || ''].concat(size).filter(Boolean).join(' ');
  const group = b.group && b.group !== '0' ? `<span class="b-grp">${esc(b.group)}</span>` : '';
  const where = b.where ? `<span class="b-where">${esc(b.where)}</span>` : '';
  const label = `${b.code} ${b.group}, ${DAYS_FULL[b.day]} ${hhmm(b.start)} to ${hhmm(b.end)}${b.where ? `, ${b.where}` : ''}`;
  return { cls, inner: `<span class="b-code">${esc(b.code)}</span>${group}${where}`, label };
}

function renderGrid(host, blocks, opts = {}) {
  const orientation = opts.orientation || 'v';
  const [startMin, endMin] = axisRange(blocks);
  const span = endMin - startMin;
  const hours = Math.round(span / 60);
  const days = [0, 1, 2, 3, 4];
  if (blocks.some((b) => b.day === 5)) days.push(5);
  if (blocks.some((b) => b.day === 6)) days.push(6);
  const now = istanbulNow();
  const showNow = opts.nowLine && days.includes(now.day) && now.min >= startMin && now.min <= endMin;
  const byDay = new Map(days.map((d) => [d, []]));
  blocks.forEach((b) => { if (byDay.has(b.day)) byDay.get(b.day).push(b); });

  const width = host.clientWidth || 900;
  const html = [];

  if (orientation === 'h') {
    const hourPx = Math.max(78, (width - 46) / hours);
    html.push(`<div class="tt tt-h" style="--hours:${hours}">`);
    html.push('<div class="tt-row"><div></div><div class="tt-axis">');
    for (let t = startMin; t <= endMin; t += 60) {
      html.push(`<span class="tt-tick" style="left:${((t - startMin) / span) * 100}%">${hhmm(t)}</span>`);
    }
    html.push('</div></div>');
    for (const day of days) {
      const items = laneLayout(byDay.get(day), false);
      const lanes = Math.max(1, items.reduce((n, x) => Math.max(n, x.lane + 1), 0));
      html.push(`<div class="tt-row"><div class="tt-dlabel${day === now.day && opts.nowLine ? ' today' : ''}">${DAYS[day]}</div>`);
      html.push(`<div class="tt-track" style="--lanes:${lanes}">`);
      for (const { block: b, lane } of items) {
        const px = ((b.end - b.start) / 60) * hourPx;
        const size = px < 62 ? ['tiny'] : px < 104 ? ['short'] : [];
        const { cls, inner, label } = blockBody(b, size);
        html.push(`<button type="button" class="${cls}" data-block="${esc(b.id)}" aria-label="${esc(label)}"
          style="left:${((b.start - startMin) / span) * 100}%;width:${((b.end - b.start) / span) * 100}%;
          top:calc(var(--lane) * ${lane} + 2px);height:calc(var(--lane) - 4px)">${inner}</button>`);
      }
      if (showNow && day === now.day) html.push(`<div class="now-line" style="left:${((now.min - startMin) / span) * 100}%"></div>`);
      html.push('</div></div>');
    }
    html.push('</div>');
  } else {
    const ppm = width < 520 ? 0.92 : 0.86;
    html.push(`<div class="tt tt-v" style="--days:${days.length};--mins:${span};--ppm:${ppm}">`);
    html.push('<div class="tt-vhead"><div></div>');
    days.forEach((d) => html.push(`<div class="tt-vname${d === now.day && opts.nowLine ? ' today' : ''}">${DAYS[d]}</div>`));
    html.push('</div><div class="tt-vbody"><div class="tt-vaxis">');
    for (let t = startMin; t <= endMin; t += 60) {
      html.push(`<span style="top:${(t - startMin) * ppm}px">${hhmm(t)}</span>`);
    }
    html.push('</div>');
    for (const day of days) {
      html.push('<div class="tt-vcol">');
      for (const { block: b, lane, lanes } of laneLayout(byDay.get(day), true)) {
        const h = (b.end - b.start) * ppm;
        const colPx = (width - 46) / days.length / lanes;
        const size = [];
        if (h < 46) size.push('short');
        if (h < 30 || colPx < 52) size.push('tiny');
        else if (colPx < 78) size.push('short');
        const { cls, inner, label } = blockBody(b, size);
        html.push(`<button type="button" class="${cls}" data-block="${esc(b.id)}" aria-label="${esc(label)}"
          style="top:${(b.start - startMin) * ppm}px;height:${Math.max(16, h - 3)}px;
          left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${(1 / lanes) * 100}% - 4px)">${inner}</button>`);
      }
      if (showNow && day === now.day) html.push(`<div class="now-line" style="top:${(now.min - startMin) * ppm}px"></div>`);
      html.push('</div>');
    }
    html.push('</div></div>');
  }

  host.innerHTML = `<div class="tt-scroll">${html.join('')}</div>`;
  if (opts.empty) {
    const wrap = document.createElement('div');
    wrap.className = 'tt-empty';
    wrap.innerHTML = opts.empty;
    host.firstChild.style.position = 'relative';
    host.firstChild.appendChild(wrap);
  }
}

/* ------------------------------------------------------------ timetable view */

function orientation() {
  if (store.prefs.orientation !== 'auto') return store.prefs.orientation;
  return window.innerWidth >= 1000 ? 'h' : 'v';
}

function swapPatterns(code, type) {
  const course = App.idx.byCode.get(code);
  const comp = course.components.find((c) => c.type === type);
  const e = entry(code);
  const lecture = type === '' ? null : App.idx.byCrn.get(e.sel['']);
  const current = App.idx.byCrn.get(e.sel[type]);
  const patterns = new Map();
  for (const s of compatibleSections(course, comp, lecture)) {
    if (s.tba || !s.meetings.length) continue;
    if (current && s.sig === current.sig) continue;
    if (!patterns.has(s.sig)) patterns.set(s.sig, []);
    patterns.get(s.sig).push(s);
  }
  return [...patterns.values()];
}

function renderTimetable() {
  const host = $('#grid');
  const blocks = planBlocks();
  const { ids, pairs } = computeClashes(blocks);
  blocks.forEach((b) => { if (ids.has(b.id)) b.cls = `${b.cls || ''} clash`.trim(); });

  let all = blocks;
  const swap = App.swap;
  if (swap) {
    const dim = blocks.map((b) => ({ ...b, cls: `${b.cls || ''} ${b.kind !== 'custom' && b.courseCode === swap.code && b.type === swap.type ? 'active' : 'dim'}` }));
    const ghosts = [];
    const occupied = blocks.filter((b) => !(b.courseCode === swap.code && b.type === swap.type));
    swapPatterns(swap.code, swap.type).forEach((sections, pi) => {
      const rep = sections[0];
      rep.meetings.forEach((m, mi) => {
        const willClash = occupied.some((o) => overlapMinutes(o, m) > 0);
        ghosts.push({
          id: `g:${pi}:${mi}`, kind: 'ghost', day: m.day, start: m.start, end: m.end,
          color: entry(swap.code).color, code: rep.component.code,
          group: sections.length > 1 ? `${sections.length} options` : rep.group,
          where: sections.length > 1 ? '' : m.place,
          cls: `ghost${willClash ? ' will-clash' : ''}`, sections,
        });
      });
    });
    all = dim.concat(ghosts);
    App.blockData = new Map(all.map((b) => [b.id, b]));
  } else {
    App.blockData = new Map(blocks.map((b) => [b.id, b]));
  }

  const emptyHTML = (!blocks.length && !swap)
    ? `<div><p>No courses yet</p><small>Search by code (EE 311), title (signals) or an instructor's name.</small>
       <button class="btn" id="sample-btn" type="button">Load a sample first-year timetable</button></div>`
    : '';
  renderGrid(host, all, { orientation: orientation(), nowLine: store.term === defaultTermCode(App.index.terms), empty: emptyHTML });

  // swap bar
  const hint = $('#hint');
  if (hint) {
    const show = !store.prefs.hintDone && blocks.length && !swap;
    hint.hidden = !show;
  }

  const bar = $('#swapbar');
  if (swap) {
    const comp = App.idx.byCode.get(swap.code).components.find((c) => c.type === swap.type);
    bar.hidden = false;
    bar.innerHTML = `<span>Pick another slot for ${esc(comp.code)}</span><button type="button" id="swap-cancel">Done</button>`;
  } else {
    bar.hidden = true;
    bar.innerHTML = '';
  }

  // TBA strip
  const tba = selectedSections().filter((s) => s.tba);
  $('#tba-strip').innerHTML = tba.length
    ? `<span>No fixed meeting time:</span>${tba.map((s) => `<span class="tba-item">${esc(s.component.code)} ${esc(s.group)}</span>`).join('')}`
    : '';

  renderSummary(pairs);
  renderRegDays();
  renderFinals();
  renderCourseList(pairs);
}

/** Which day of registration a course opens for the student's programme(s). */
function myPrograms() {
  const chosen = (store.prefs.programs || []).filter(Boolean);
  return chosen;
}

function registrationDay(code) {
  if (!App.regdays) return null;
  const entry = App.regdays.courses[code];
  if (!entry) return { day: null, entry: null };
  const mine = myPrograms();
  for (const day of ['1', '2', '3']) {
    const value = entry.days[day];
    if (!value) continue;
    if (value === 'ALL' || (mine.length && mine.some((p) => value.includes(p)))) {
      return { day: Number(day), entry, all: value === 'ALL' };
    }
  }
  return { day: null, entry };
}

const regDate = (day) => (App.calendar && App.calendar.registrationDays ? App.calendar.registrationDays[day - 1] : null);
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function renderRegDays() {
  const host = $('#regdays');
  if (!host) return;
  if (!App.regdays) { host.innerHTML = ''; return; }

  const options = (extra) => ['<option value="">—</option>'].concat(App.regdays.programs.map((p) =>
    `<option value="${esc(p)}"${p === extra ? ' selected' : ''}>${esc(p)}</option>`)).join('');
  const [first, second] = myPrograms();

  const rows = [];
  for (const code of tt().order) {
    const e = tt().courses[code];
    const course = App.idx.byCode.get(code);
    if (!e || e.hidden || !course) continue;
    const crns = course.components.map((comp) => App.idx.byCrn.get(e.sel[comp.type])).filter(Boolean);
    rows.push({ code, crns, ...registrationDay(code), color: e.color });
  }
  rows.sort((a, b) => (a.day || 9) - (b.day || 9) || naturalKey(a.code).localeCompare(naturalKey(b.code)));

  const earned = store.plan ? earnedCredits(allPlanned()) : 0;
  const senior = earned >= 94;
  const dayOne = senior ? seniorDayOneCodes() : new Set();
  rows.forEach((row) => {
    if (dayOne.has(row.code) && row.day !== 1) { row.day = 1; row.senior = true; }
  });
  rows.sort((a, b) => (a.day || 9) - (b.day || 9) || naturalKey(a.code).localeCompare(naturalKey(b.code)));

  host.innerHTML = `
    <div class="reg-head">
      <h3 class="side-head">Registration days</h3>
      <label class="reg-pick">Programme
        <select class="select" id="reg-program">${options(first)}</select></label>
      <label class="reg-pick">Double major
        <select class="select" id="reg-major2">${options(second)}</select></label>
    </div>
    ${myPrograms().length ? `
      <table class="reg-table">
        <tr><th>Day</th><th>Course</th><th>CRNs</th><th></th></tr>
        ${rows.map((row) => `<tr>
          <td>${row.day ? `<span class="day-badge d${row.day}${regDate(row.day) === istanbulToday() ? ' today' : ''}">Day ${row.day}${regDate(row.day) ? ` · ${esc(shortDate(regDate(row.day)))}` : ''}</span>`
            : '<span class="day-badge none">not listed</span>'}</td>
          <td class="reg-code c${row.color}">${esc(row.code)}</td>
          <td class="reg-crns">${row.crns.map((s) => `<button type="button" class="crn-chip" data-crn="${esc(s.crn)}">${esc(s.crn)}</button>${seatBadge(s.crn)}`).join('')}</td>
          <td class="reg-flags">${[
            row.senior ? 'senior: required/core' : '',
            row.entry && row.entry.critical ? 'critical' : '',
            row.entry && row.entry.restricted ? 'class restriction' : '',
            row.day === 3 && !row.all ? '' : '',
          ].filter(Boolean).join(', ')}</td>
        </tr>`).join('')}
      </table>
      ${rows.some((r) => !r.day) ? '<p class="cat-sub">“Not listed” means the course was added after the list was issued — check the announcement.</p>' : ''}
      ${rows.some((r) => r.entry && r.entry.restricted) ? '<p class="cat-sub">Courses marked with a class restriction keep it on every day; the catalog says which classes.</p>' : ''}
      ${senior ? `<p class="cat-sub">You have senior standing (94+ credits), so on day one you can also take your programme's required and core courses${currentProgram() ? ' — they are moved to day 1 above' : ' (pick your programme in the Plan tab to see which)'}.</p>` : ''}
      ${(() => {
        const todayIndex = App.calendar && App.calendar.registrationDays ? App.calendar.registrationDays.indexOf(istanbulToday()) : -1;
        if (todayIndex < 0) return '';
        const due = rows.filter((r) => r.day === todayIndex + 1);
        return `<p class="reg-today">Today is registration day ${todayIndex + 1}${due.length ? ` — ${due.map((r) => esc(r.code)).join(', ')} open${due.length === 1 ? 's' : ''} for you` : ''}.</p>`;
      })()}
      ${App.regdays.issued ? `<p class="cat-sub">List issued ${esc(App.regdays.issued)}. Courses opened or closed later aren't on it.</p>` : ''}
    ` : '<p class="empty-note">Pick your programme to see which day each course opens for you.</p>'}`;
}

function renderFinals() {
  const host = $('#finals');
  if (!host) return;
  if (!App.exams || !tt().order.length) { host.innerHTML = ''; return; }
  const { rows, clashes } = examPlan();
  if (!rows.length) {
    host.innerHTML = `<p class="empty-note">No finals listed yet for these courses.</p>`;
    return;
  }
  host.innerHTML = `<h3 class="side-head">Finals</h3>${rows.map(({ exam, sec }, i) => `
    <div class="final-row${clashes.has(i) ? ' clash' : ''}">
      <span class="final-code c${(entry(sec.course.code) || {}).color || 0}">${esc(sec.course.code)}</span>
      <span>${esc(fmtDate(exam.date))}${exam.start !== null && exam.start !== undefined ? `, ${esc(hhmm(exam.start))}` : ''}</span>
      <span class="final-where">${esc(exam.place || '')}</span>
    </div>`).join('')}${clashes.size ? '<p class="course-note clash">Two finals overlap — talk to Student Resources.</p>' : ''}`;
}

function renderSummary(pairs) {
  const codes = tt().order.filter((c) => !tt().courses[c].hidden && App.idx.byCode.has(c));
  const courses = codes.map((c) => App.idx.byCode.get(c));
  const credits = courses.map((c) => c.credits);
  const stats = [`<span class="stat"><b>${codes.length}</b> course${codes.length === 1 ? '' : 's'}</span>`];
  if (codes.length && credits.every((c) => c !== null)) {
    const total = credits.reduce((a, b) => a + b, 0);
    stats.push(`<span class="stat"><b>${total}</b> SU credits</span>`);
  }
  const ects = codes.map((c) => (courseInfo(c) || {}).ects);
  if (codes.length && ects.every((v) => typeof v === 'number')) {
    stats.push(`<span class="stat"><b>${ects.reduce((a, b) => a + b, 0)}</b> ECTS</span>`);
  }
  const contact = courses.reduce((n, c) => {
    const e = tt().courses[c.code];
    return n + c.components.reduce((m, comp) => {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      return m + (sec ? sec.meetings.reduce((k, x) => k + x.end - x.start + 10, 0) : 0);
    }, 0);
  }, 0);
  if (contact) stats.push(`<span class="stat"><b>${Math.round(contact / 60)}</b> h of class a week</span>`);
  const days = new Set(planBlocks().map((b) => b.day));
  if (days.size) stats.push(`<span class="stat"><b>${days.size}</b> day${days.size === 1 ? '' : 's'} on campus</span>`);
  if (pairs.length) stats.push(`<span class="stat warn">${pairs.length} clash${pairs.length === 1 ? '' : 'es'}</span>`);
  $('#summary').innerHTML = stats.join('');

  const canShare = location.protocol === 'http:' || location.protocol === 'https:';
  $('#actions').innerHTML = codes.length || customEvents().length ? [
    '<button class="btn primary" id="act-crn" type="button">CRNs for registration</button>',
    '<button class="btn" id="act-arrange" type="button">Optimiser</button>',
    '<button class="btn" id="act-export" type="button">Add to calendar</button>',
    '<button class="btn" id="act-image" type="button">Save as image</button>',
    '<button class="btn" id="act-event" type="button">+ Event</button>',
    canShare ? '<button class="btn" id="act-share" type="button">Copy share link</button>' : '',
    '<button class="btn quiet" id="act-clear" type="button">Clear</button>',
  ].filter(Boolean).join('') : '<button class="btn" id="act-crn" type="button">Paste CRNs</button><button class="btn" id="act-event" type="button">+ Event</button>';
}

function sectionOptionLabel(sec) {
  const when = sec.meetings.length
    ? sec.meetings.map((m) => `${DAYS[m.day]} ${hhmm(m.start)}`).join(', ')
    : 'no fixed time';
  const who = sec.people[0] ? `, ${sec.people[0].split(' ').slice(-1)[0]}` : '';
  const seats = seatInfo(sec.crn);
  const left = seats ? (seats.remaining <= 0 ? ' — full' : ` — ${seats.remaining} left`) : '';
  return `${sec.group}: ${when}${who} (${sec.crn})${left}`;
}

function renderCourseList(pairs) {
  const host = $('#course-list');
  const t = tt();
  const events = customEvents();
  const eventsHTML = events.length ? `<div class="events-list"><h3 class="side-head">Your events</h3>${events.map((ev) => `
    <button type="button" class="event-row c${ev.color ?? 7}" data-event="${esc(ev.id)}">
      <span class="final-code">${esc(ev.title)}</span>
      <span>${esc(DAYS[ev.day])} ${esc(hhmm(ev.start))}–${esc(hhmm(ev.end))}</span>
      <span class="final-where">${esc(ev.place || '')}</span>
    </button>`).join('')}</div>` : '';
  if (!t.order.length) {
    if (eventsHTML) { host.innerHTML = eventsHTML; return; }
    host.innerHTML = '<p class="empty-note">Courses you add show up here with their sections and CRNs.</p>';
    return;
  }
  const clashText = new Map();
  for (const [a, b] of pairs) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!x.courseCode) continue;
      const line = `${y.code}${y.group ? ` ${y.group}` : ''} on ${DAYS[x.day]} ${hhmm(Math.max(x.start, y.start))}`;
      if (!clashText.has(x.courseCode)) clashText.set(x.courseCode, new Set());
      clashText.get(x.courseCode).add(line);
    }
  }

  const html = t.order.map((code) => {
    const e = t.courses[code];
    const course = App.idx.byCode.get(code);
    if (!course) return '';
    const rows = course.components.map((comp) => {
      const cur = App.idx.byCrn.get(e.sel[comp.type]);
      const lecture = comp.type === '' ? null : App.idx.byCrn.get(e.sel['']);
      const preferred = compatibleSections(course, comp, lecture);
      const rest = comp.sections.filter((s) => !preferred.includes(s));
      const optionTag = (s) => `<option value="${esc(s.crn)}"${cur && s.crn === cur.crn ? ' selected' : ''}>${esc(sectionOptionLabel(s))}</option>`;
      const opts = preferred.map(optionTag).join('')
        + (rest.length ? `<optgroup label="Other lecture groups — may not be allowed">${rest.map(optionTag).join('')}</optgroup>` : '');
      return `<div class="comp-row"><span class="comp-name">${esc(comp.code)}</span>
        <select class="select sec-select" data-code="${esc(code)}" data-type="${esc(comp.type)}"
          aria-label="${esc(comp.code)} section">${opts}</select></div>`;
    }).join('');
    const who = mainInstructors(course, e);
    const clashes = clashText.get(code);
    const mismatch = linkMismatch(course, e);
    const fullSections = course.components.map((comp) => App.idx.byCrn.get(e.sel[comp.type]))
      .filter((s) => s && seatInfo(s.crn) && seatInfo(s.crn).remaining <= 0);
    return `<div class="course c${e.color}${e.hidden ? ' hidden-course' : ''}" data-code="${esc(code)}">
      <div class="course-top">
        <button class="swatch" type="button" data-act="palette" aria-label="Change colour"></button>
        <div class="grow">
          <div class="course-code">${esc(course.code)}${course.credits !== null ? ` <span class="course-title">${course.credits} cr</span>` : ''}</div>
          <div class="course-title">${esc(course.title)}</div>
        </div>
        <div class="course-btns">
          <button type="button" data-act="info" aria-label="Details for ${esc(code)}" title="Details, syllabus, description">${icon('info')}</button>
          <button type="button" data-act="hide" aria-label="${e.hidden ? 'Show' : 'Hide'} ${esc(code)}" title="${e.hidden ? 'Show' : 'Hide'}">${e.hidden ? icon('eye-off') : icon('eye')}</button>
          <button type="button" data-act="remove" aria-label="Remove ${esc(code)}" title="Remove">${icon('trash')}</button>
        </div>
      </div>
      ${e.paletteOpen ? `<div class="palette">${Array.from({ length: COLORS }, (_, i) =>
        `<button type="button" class="c${i}" data-act="color" data-color="${i}" aria-pressed="${i === e.color}" aria-label="Colour ${i + 1}"></button>`).join('')}</div>` : ''}
      ${rows}
      ${who ? `<div class="course-note">${esc(who)}</div>` : ''}
      ${mismatch ? `<div class="course-note warn">${esc(mismatch)}</div>` : ''}
      ${fullSections.length ? `<div class="course-note clash">${esc(fullSections.map((s) => `${s.component.code} ${s.group}`).join(', '))} ${fullSections.length === 1 ? 'is' : 'are'} full — pick another section or watch for drops.</div>` : ''}
      ${clashes ? `<div class="course-note clash">Clashes with ${esc([...clashes].join('; '))}</div>` : ''}
    </div>`;
  }).join('');
  host.innerHTML = html;
}

/** Courses that letter their groups after the lecture (B -> B1, B2): flag a mixed pair. */
function linkMismatch(course, e) {
  const lecture = App.idx.byCrn.get(e.sel['']);
  if (!lecture) return '';
  const off = [];
  for (const comp of course.components) {
    if (comp.type === '' || !componentLinks(course, comp)) continue;
    const sec = App.idx.byCrn.get(e.sel[comp.type]);
    if (!sec) continue;
    const letter = linkLetter(sec.group);
    if (letter && letter !== lecture.group.toUpperCase()) off.push(`${comp.code} ${sec.group}`);
  }
  if (!off.length) return '';
  return `${off.join(', ')} belongs to another lecture group — some courses require the matching one, so check BannerWeb.`;
}

function mainInstructors(course, e) {
  const sec = App.idx.byCrn.get(e.sel['']) || App.idx.byCrn.get(Object.values(e.sel)[0]);
  if (!sec || !sec.people.length) return '';
  return sec.people.slice(0, 3).join(', ') + (sec.people.length > 3 ? ` +${sec.people.length - 3}` : '');
}

function icon(name) {
  const paths = {
    eye: '<path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2.1"/>',
    'eye-off': '<path d="M2 2l12 12"/><path d="M6.3 6.4A2.1 2.1 0 008 10.1c.5 0 1-.2 1.4-.5"/><path d="M1 8s2.6-4.5 7-4.5c1 0 1.9.2 2.7.5M14.2 10A12 12 0 0015 8s-2.6-4.5-7-4.5"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8L11 4.5"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z"/>',
    grid: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M6 6v7.5"/>',
    book: '<path d="M2.5 3.5h4a2 2 0 012 2v8a1.6 1.6 0 00-1.4-1H2.5zM13.5 3.5h-4a2 2 0 00-2 2v8a1.6 1.6 0 011.4-1h4.6z"/>',
    door: '<path d="M4 2.5h8v11H4zM9.6 8.2v.1"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4M8 4.9v.1"/>',
  };
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

/* -------------------------------------------------------------------- search */

function searchCourses(query, limit = 25) {
  const q = fold(query).trim();
  if (!q) return [];
  const compact = q.replace(/\s+/g, '');
  const tokens = q.split(/\s+/);
  const hits = [];
  for (const c of App.idx.courses) {
    let score = 0;
    if (c.foldCode === compact) score = 1000;
    else if (c.foldCode.startsWith(compact)) score = 800 - (c.foldCode.length - compact.length);
    else {
      let ok = true, s = 0;
      for (const t of tokens) {
        if (c.foldCode.includes(t)) { s += 50; continue; }
        const ti = c.foldTitle.indexOf(t);
        if (ti === 0 || (ti > 0 && /\s/.test(c.foldTitle[ti - 1]))) { s += 60; continue; }
        if (ti > 0) { s += 28; continue; }
        if (c.foldPeople.includes(t)) { s += 22; continue; }
        ok = false; break;
      }
      if (ok) score = s;
    }
    if (score > 0) hits.push({ c, score });
  }
  hits.sort((a, b) => b.score - a.score || naturalKey(a.c.code).localeCompare(naturalKey(b.c.code)));
  return hits.slice(0, limit).map((h) => h.c);
}

function renderSearchResults() {
  const box = $('#search-results');
  const q = $('#search').value;
  $('#search').parentElement.classList.toggle('filled', !!q);
  if (!q.trim()) { box.hidden = true; box.innerHTML = ''; return; }
  const results = searchCourses(q);
  App.results = results;
  if (!results.length) {
    box.innerHTML = `<p class="res-empty">Nothing matches “${esc(q)}” in ${esc(App.idx.name)}.</p>`;
  } else {
    box.innerHTML = results.map((c, i) => {
      const added = !!entry(c.code);
      return `<button type="button" class="res${i === (App.resultIndex || 0) ? ' active' : ''}" data-code="${esc(c.code)}">
        <span class="res-code">${esc(c.code)}</span>
        <span class="res-title">${esc(c.title)}</span>
        <span class="res-tag${added ? ' added' : ''}">${added ? 'Added' : (c.credits !== null ? `${c.credits} cr` : 'Add')}</span>
      </button>`;
    }).join('');
  }
  box.hidden = false;
}

function closeSearch() {
  $('#search-results').hidden = true;
  App.resultIndex = 0;
}

function pickResult(code) {
  if (entry(code)) removeCourse(code); else addCourse(code);
  $('#search').value = '';
  $('#search').parentElement.classList.remove('filled');
  closeSearch();
  if (!matchMedia('(pointer: coarse)').matches) $('#search').focus();
}

/* ------------------------------------------------------------- catalog view */

function renderCatalog() {
  const q = $('#cat-search').value;
  const subj = $('#cat-subject').value;
  const level = App.catLevel || 'all';
  let list = q.trim() ? searchCourses(q, 400) : App.idx.courses;
  if (subj !== 'all') list = list.filter((c) => c.subj === subj);
  if (level !== 'all') list = list.filter((c) => c.level.includes(level === 'ug' ? 'UG' : 'GR'));
  App.catalogList = list;
  const shown = list.slice(0, App.catalogLimit);
  $('#cat-count').textContent = `${list.length} course${list.length === 1 ? '' : 's'}`;
  $('#catalog').innerHTML = shown.map((c) => {
    const added = !!entry(c.code);
    const parts = c.components.map((cp) => `${cp.label || cp.code} ×${cp.sections.length}`).join(', ');
    return `<div class="cat-item" data-code="${esc(c.code)}">
      <button class="cat-head" type="button" data-act="toggle">
        <span class="grow">
          <span class="cat-code">${esc(c.code)}</span> <span class="cat-title">${esc(c.title)}</span>
          <span class="cat-sub">${esc(parts)}${c.instructors[0] ? ` — ${esc(c.instructors.slice(0, 2).join(', '))}` : ''}</span>
        </span>
        <span class="cat-add"><span class="btn ${added ? 'quiet' : ''}" data-act="add">${added ? 'Remove' : 'Add'}</span></span>
      </button>
      <div class="cat-body"></div>
    </div>`;
  }).join('') + (list.length > shown.length
    ? `<button class="btn" id="cat-more" type="button">Show ${Math.min(200, list.length - shown.length)} more</button>` : '');
}

function courseDetailHTML(course, { heading = false } = {}) {
  const info = courseInfo(course.code) || {};
  const meta = [];
  if (course.credits !== null) meta.push(`${course.credits} SU credits`);
  if (info.ects) meta.push(`${info.ects} ECTS`);
  meta.push(course.level === 'GR' ? 'Graduate' : course.level === 'UG' ? 'Undergraduate' : course.level);
  if (info.language) meta.push(info.language);

  const extras = [
    ['Prerequisite', info.prereq],
    ['Corequisite', info.coreq],
    ['Objectives', info.objectives],
    ['Textbook', info.textbook],
    ['Assessment', info.assessment],
  ].filter(([, v]) => v);

  const exams = (App.exams && App.exams.byCode.get(course.code)) || [];
  const examHTML = exams.length ? `<p class="detail-extra"><b>Final</b> ${exams.map((x) =>
    `${x.section ? `${esc(x.section)}: ` : ''}${esc(fmtDate(x.date))}${x.start !== null && x.start !== undefined ? ` ${esc(hhmm(x.start))}` : ''}${x.place ? `, ${esc(x.place)}` : ''}`).join(' · ')}</p>` : '';

  const lectureish = course.lecture || course.components[0];
  const links = [`<a class="btn" href="${esc(catalogURL(course))}" target="_blank" rel="noopener">Course catalog</a>`];
  if (lectureish && lectureish.sections.length) {
    const groups = lectureish.sections.slice(0, 6);
    groups.forEach((s) => links.push(
      `<a class="btn" href="${esc(syllabusURL(course, lectureish, s.group))}" target="_blank" rel="noopener">Syllabus ${esc(s.group)}</a>`));
  }

  return `
    ${heading ? `<div class="detail-head"><span class="cat-code">${esc(course.code)}</span> <span class="cat-title">${esc(course.title)}</span></div>` : ''}
    <p class="detail-meta">${esc(meta.join(' · '))}</p>
    ${info.desc ? `<p class="detail-desc">${esc(info.desc)}</p>`
      : '<p class="detail-desc muted">No description saved for this term yet — the syllabus and catalog pages below have it.</p>'}
    ${offeringHistory(course.code) ? `<p class="detail-extra"><b>Offered</b> ${esc(offeringHistory(course.code))}</p>` : ''}
    ${examHTML}
    ${extras.map(([label, value]) => `<p class="detail-extra"><b>${esc(label)}</b> ${esc(value)}</p>`).join('')}
    ${prereqGraphSVG(course.code)}
    ${workloadHTML(course)}
    <div class="detail-links">${links.join('')}</div>
    ${App.seats || LIVE_SEATS ? `<p class="seat-note">${esc(seatsStamp())}${LIVE_SEATS ? ' <button type="button" class="btn quiet" id="seats-refresh">Refresh seats</button>' : ''}</p>` : ''}
    ${course.components.map((comp) => `
    <table class="sec-table">
      <caption>${esc(comp.label || 'Sections')} — ${esc(comp.code)}</caption>
      <tr><th>Section</th><th>When</th><th>Where</th><th>Instructor</th><th>CRN</th>${App.seats || LIVE_SEATS ? '<th>Seats</th>' : ''}<th></th></tr>
      ${comp.sections.map((s) => `<tr>
        <td>${esc(s.group)}</td>
        <td>${s.meetings.length ? s.meetings.map((m) => `${DAYS[m.day]} ${hhmm(m.start)}–${hhmm(m.end)}`).join('<br>') : '<span class="muted">TBA</span>'}</td>
        <td class="muted">${s.meetings.map((m) => esc(m.place)).filter(Boolean).join('<br>') || '—'}</td>
        <td class="muted">${esc(s.people.join(', ')) || '—'}</td>
        <td><a href="${esc(bannerURL(s.crn))}" target="_blank" rel="noopener">${esc(s.crn)}</a></td>
        ${App.seats || LIVE_SEATS ? `<td>${seatBadge(s.crn) || '<span class="muted">—</span>'}</td>` : ''}
        <td><a href="${esc(syllabusURL(course, comp, s.group))}" target="_blank" rel="noopener">syllabus</a></td>
      </tr>`).join('')}
    </table>`).join('')}`;
}

/** ECTS for a course from whatever we have: course info, programme table, transcript. */
function ectsOf(code) {
  const info = courseInfo(code);
  if (info && info.ects) return info.ects;
  const program = currentProgram();
  if (program && program.credits && program.credits[code] && program.credits[code][1]) return program.credits[code][1];
  const planned = store.plan && (store.plan.terms || []).flatMap((t) => t.courses).find((c) => c.code === code && c.ects);
  return planned ? planned.ects : null;
}

/**
 * Weekly hours: contact time per component comes straight from the schedule; the total comes
 * from ECTS (1 ECTS = 25–30 hours of work over a ~14-week term), and the rest is self-study.
 */
function workloadOf(course) {
  const parts = course.components.map((comp) => {
    const minutes = comp.sections.map((s) => s.meetings.reduce((n, m) => n + (m.end - m.start + 10), 0)).filter((n) => n > 0);
    if (!minutes.length) return null;
    minutes.sort((a, b) => a - b);
    const typical = minutes[Math.floor(minutes.length / 2)];
    return { label: comp.label || comp.code, hours: Math.round(typical / 60 * 2) / 2 };
  }).filter(Boolean);
  const contact = parts.reduce((n, p) => n + p.hours, 0);
  const ects = ectsOf(course.code);
  const total = ects ? { low: Math.round(ects * 25 / 14), high: Math.round(ects * 30 / 14) } : null;
  return { parts, contact, ects, total, study: total ? { low: Math.max(0, total.low - contact), high: Math.max(0, total.high - contact) } : null };
}

function workloadHTML(course) {
  const w = workloadOf(course);
  if (!w.parts.length) return '';
  const max = Math.max(w.total ? w.total.high : 0, w.contact, 1);
  const palette = ['c0', 'c2', 'c1', 'c4', 'c5'];
  const segments = w.parts.map((p, i) => `<span class="wl-seg ${palette[i % palette.length]}" style="width:${(p.hours / max) * 100}%" title="${esc(p.label)}: ${p.hours} h"></span>`).join('')
    + (w.study ? `<span class="wl-seg study" style="width:${(((w.study.low + w.study.high) / 2) / max) * 100}%" title="Self-study"></span>` : '');
  return `<div class="workload">
    <h3>Weekly workload</h3>
    <div class="wl-bar">${segments}</div>
    <p class="wl-legend">${w.parts.map((p, i) => `<span><i class="${palette[i % palette.length]}"></i>${esc(p.label)} ${p.hours} h</span>`).join('')}
      ${w.study ? `<span><i class="study"></i>self-study ≈ ${w.study.low}–${w.study.high} h</span>` : ''}</p>
    <p class="cat-sub">${w.total ? `≈ ${w.total.low}–${w.total.high} hours a week in total, from ${esc(w.ects)} ECTS (25–30 hours each over the term).`
      : 'Class hours come from the schedule; the self-study estimate appears once the ECTS value is known.'}</p>
  </div>`;
}

/* ------------------------------------------------------ prerequisite graph */

/** Two levels of prerequisites on the left, the course in the middle, what it opens on the right. */
function prereqGraphSVG(code) {
  const groups = requirementGroups(code);
  const opens = unlockedBy(code);
  if (!groups.length && !opens.length) return '';
  const back1 = [];
  groups.forEach((group, gi) => group.forEach((c) => back1.push({ code: c, group: gi, alt: group.length > 1 })));
  const back2 = [];
  const edges = [];
  back1.forEach((node) => {
    requirementGroups(node.code).forEach((group) => group.forEach((c) => {
      if (!back2.some((n) => n.code === c)) back2.push({ code: c });
      edges.push([c, node.code]);
    }));
    edges.push([node.code, code]);
  });
  opens.forEach((c) => edges.push([code, c]));
  const columns = [back2, back1, [{ code, center: true }], opens.map((c) => ({ code: c }))].filter((col) => col.length);
  const colW = 126, rowH = 34, nodeW = 96, nodeH = 26, pad = 12;
  const height = Math.max(...columns.map((c) => c.length)) * rowH + pad * 2;
  const width = columns.length * colW;
  const pos = new Map();
  columns.forEach((col, ci) => {
    const offset = (height - col.length * rowH) / 2;
    col.forEach((node, ri) => pos.set(`${ci}:${node.code}`, { x: ci * colW + (colW - nodeW) / 2, y: offset + ri * rowH + (rowH - nodeH) / 2, node, ci }));
  });
  const find = (c, preferCol) => [...pos.values()].filter((p) => p.node.code === c).sort((a, b) => Math.abs(a.ci - preferCol) - Math.abs(b.ci - preferCol))[0];
  const paths = edges.map(([from, to]) => {
    const b = find(to, 99);
    const a = b ? find(from, b.ci - 1) : null;
    if (!a || !b || a.ci >= b.ci) return '';
    const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="pg-edge"/>`;
  }).join('');
  const nodes = [...pos.values()].map(({ x, y, node }) => {
    const known = App.idx.byCode.has(node.code) || (App.union && App.union.has(node.code));
    return `<g class="pg-node${node.center ? ' center' : ''}${known ? '' : ' off'}${node.alt ? ' alt' : ''}" data-course="${esc(node.code)}" tabindex="0" role="button">
      <rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8"/>
      <text x="${x + nodeW / 2}" y="${y + nodeH / 2 + 4}" text-anchor="middle">${esc(node.code)}</text></g>`;
  }).join('');
  const heads = [back2.length ? 'Before that' : null, back1.length ? 'Needs first' : null, 'This course', opens.length ? 'Opens up' : null].filter(Boolean);
  return `<div class="pg-wrap"><svg class="pg" viewBox="0 0 ${width} ${height + 18}" style="max-width:${width}px" role="img" aria-label="Prerequisites of ${esc(code)}">
    ${heads.map((h, i) => `<text x="${i * colW + colW / 2}" y="12" text-anchor="middle" class="pg-head">${h}</text>`).join('')}
    <g transform="translate(0,18)">${paths}${nodes}</g></svg>
    ${back1.some((n) => n.alt) ? '<p class="cat-sub">Outlined boxes are alternatives — one of them is enough.</p>' : ''}</div>`;
}

function openCourseDialog(code) {
  const course = App.idx.byCode.get(code);
  if (!course) return;
  if (!App.union) ensureUnion().then(() => { if ($('#dlg-course').open) openCourseDialog(code); });
  const added = !!entry(code);
  $('#course-dlg-title').textContent = `${course.code} ${course.title}`;
  $('#course-body').innerHTML = courseDetailHTML(course);
  $('#course-add').textContent = added ? 'Remove from timetable' : 'Add to timetable';
  $('#course-add').dataset.code = code;
  if (!$('#dlg-course').open) $('#dlg-course').showModal();
  if (LIVE_SEATS && !App.liveFetched?.[code]) {
    (App.liveFetched = App.liveFetched || {})[code] = true;
    const crns = course.components.flatMap((comp) => comp.sections.map((s) => s.crn));
    refreshSeats(crns).then((ok) => { if (ok && $('#dlg-course').open) openCourseDialog(code); });
  }
}

/* ------------------------------------------------------------- degree plan */

const SEASON = { '01': 'Fall', '02': 'Spring', '03': 'Summer' };
const GRADE_POINTS = { A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, 'C-': 1.7, 'D+': 1.3, D: 1, F: 0, NA: 0 };
const GRADE_OPTIONS = ['', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'F', 'S', 'U', 'P', 'W', 'NA', 'T', 'I'];
const PASSING = new Set(['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'S', 'T', 'P', 'SL', 'EL']);

const termLabel = (id) => `${SEASON[id.slice(4)] || id.slice(4)} ${id.slice(0, 4)}-${Number(id.slice(0, 4)) + 1}`;

function nextTerm(id) {
  const year = Number(id.slice(0, 4));
  const part = id.slice(4);
  if (part === '01') return `${year}02`;
  return `${year + 1}01`;
}

function planState() {
  const plan = store.plan || (store.plan = { program: null, terms: [] });
  if (!plan.terms) plan.terms = [];
  if (plan.sem) {                       // migrate the old year/semester grid
    const base = Number((App.index?.terms?.[0]?.code || '202601').slice(0, 4)) - (plan.years || 4) + 1;
    Object.entries(plan.sem).forEach(([key, codes]) => {
      if (!codes || !codes.length) return;
      const year = base + Number(key[0]) - 1;
      const id = `${year}${{ F: '01', S: '02', U: '03' }[key.slice(-1)] || '01'}`;
      const term = plan.terms.find((t) => t.id === id) || { id, courses: [] };
      codes.forEach((code) => { if (!term.courses.some((c) => c.code === code)) term.courses.push({ code }); });
      if (!plan.terms.includes(term)) plan.terms.push(term);
    });
    delete plan.sem;
    delete plan.years;
    delete plan.summers;
  }
  plan.terms.sort((a, b) => a.id.localeCompare(b.id));
  return plan;
}

const planTerm = (id) => planState().terms.find((t) => t.id === id);

/** Every course in the archive (data/catalog.json), for planning and offering history. */
async function loadCatalog() {
  if (App.catalog) return App.catalog;
  let raw = window.SUMODS_DATA ? window.SUMODS_DATA.catalog : null;
  if (!raw && !window.SUMODS_DATA) raw = await fetchJSON('data/catalog.json').catch(() => null);
  App.catalog = raw;
  return raw;
}

async function ensureUnion() {
  if (App.union) return App.union;
  const union = new Map();
  const catalog = await loadCatalog();
  if (catalog) {
    for (const [code, c] of Object.entries(catalog.courses)) {
      union.set(code, { code, title: c.title, credits: c.credits ?? null, terms: new Set(c.terms) });
    }
  } else {
    for (const term of App.index.terms) {
      let raw;
      try {
        // eslint-disable-next-line no-await-in-loop
        raw = await loadTerm(term.code);
      } catch {
        continue;
      }
      for (const course of raw.courses) {
        const existing = union.get(course.code) || { code: course.code, title: course.title, credits: course.credits ?? null, terms: new Set() };
        existing.terms.add(term.code);
        union.set(course.code, existing);
      }
    }
  }
  for (const course of union.values()) {
    course.parts = new Set([...course.terms].map((t) => t.slice(4)));
    course.foldCode = fold(course.code.replace(/\s+/g, ''));
    course.foldTitle = fold(course.title || '');
  }
  App.union = union;
  return union;
}

/** "Every fall since 2018", "Spring 2021, Spring 2024" — from the archive. */
function offeringHistory(code) {
  const course = App.union && App.union.get(code);
  if (!course || !App.catalog) return '';
  const all = App.catalog.terms;
  const ran = [...course.terms].sort();
  const bySeason = { '01': [], '02': [], '03': [] };
  ran.forEach((t) => bySeason[t.slice(4)].push(t));
  const lines = [];
  for (const [part, terms] of Object.entries(bySeason)) {
    if (!terms.length) continue;
    const possible = all.filter((t) => t.slice(4) === part && t >= terms[0]);
    const label = SEASON[part];
    if (terms.length === possible.length && terms.length > 2) lines.push(`every ${label.toLowerCase()} since ${terms[0].slice(0, 4)}`);
    else lines.push(`${label} ${terms.map((t) => t.slice(2, 4)).join(', ')}`.replace(/(\d\d)/g, "'$1"));
  }
  return lines.join('; ');
}

function courseFacts(entryOrCode) {
  const item = typeof entryOrCode === 'string' ? { code: entryOrCode } : entryOrCode;
  const known = (App.union && App.union.get(item.code)) || {};
  return {
    code: item.code,
    title: item.title || known.title || '',
    credits: item.credits ?? known.credits ?? null,
    ects: item.ects ?? null,
    grade: item.grade || '',
    parts: known.parts || new Set(),
  };
}

function searchUnion(query, limit = 8) {
  const q = fold(query).trim();
  if (!q || !App.union) return [];
  const compact = q.replace(/\s+/g, '');
  const hits = [];
  for (const course of App.union.values()) {
    let score = 0;
    if (course.foldCode === compact) score = 100;
    else if (course.foldCode.startsWith(compact)) score = 80;
    else if (course.foldTitle.includes(q)) score = 40;
    if (score) hits.push({ course, score });
  }
  hits.sort((a, b) => b.score - a.score || naturalKey(a.course.code).localeCompare(naturalKey(b.course.code)));
  return hits.slice(0, limit).map((h) => h.course);
}

function allPlanned() {
  return planState().terms.flatMap((term) => term.courses.map((c) => ({ ...courseFacts(c), term: term.id })));
}

function gpaOf(courses) {
  let points = 0;
  let credits = 0;
  for (const c of courses) {
    const value = GRADE_POINTS[c.grade];
    if (value === undefined || !c.credits) continue;
    points += value * c.credits;
    credits += c.credits;
  }
  return credits ? { gpa: points / credits, credits } : null;
}

const earnedCredits = (courses) => courses
  .filter((c) => PASSING.has(c.grade) && c.credits)
  .reduce((n, c) => n + c.credits, 0);

function planIssues(termId, course) {
  const issues = [];
  const groups = requirementGroups(course.code);
  if (groups.length) {
    const before = new Set(planState().terms.filter((t) => t.id < termId).flatMap((t) => t.courses.map((c) => c.code)));
    const missing = groups.filter((group) => !group.some((req) => before.has(req)));
    if (missing.length) issues.push(`needs ${missing.map((g) => g.join(' or ')).join(', ')} first`);
  }
  const facts = courseFacts(course);
  if (facts.parts && facts.parts.size && !facts.parts.has(termId.slice(4))) {
    issues.push(`usually offered in ${[...facts.parts].map((p) => SEASON[p]).join('/')}`);
  }
  return issues;
}

const currentProgram = () => App.requirements || null;

async function refreshRequirements() {
  const plan = planState();
  App.requirements = plan.program ? await loadRequirements(plan.program, plan.entry) : null;
  if (App.requirements && !plan.entry && App.requirements.entry !== 'any') plan.entry = App.requirements.entry;
  if (store.view === 'plan') renderPlanner();
  if (store.view === 'timetable') render();
}

/**
 * Assign planned courses to requirement areas in summary order. A course sits in the first
 * area that lists it and still has room; core electives beyond the core minimum spill into
 * area electives, and anything left over counts as a free elective.
 */
function requirementProgress(program) {
  const planned = allPlanned();
  const creditMap = program.credits || {};
  const coreCodes = new Set((program.groups || []).filter((g) => g.kind === 'core').flatMap((g) => g.courses || []));
  const used = new Set();
  const creditsOf = (course, group) => course.credits ?? (creditMap[course.code] || [])[0] ?? group.creditsEach ?? 3;
  const ectsOf = (course) => course.ects ?? (creditMap[course.code] || [])[1] ?? null;

  const accepts = (group, course) => {
    if ((group.courses || []).includes(course.code)) return true;
    if (group.kind === 'area' && coreCodes.has(course.code)) return true;
    if (group.kind === 'free' || group.any) return true;
    if (group.match) {
      try { return new RegExp(`^${group.match}$`).test(course.code); } catch { return false; }
    }
    return false;
  };
  const full = (group, matches) => {
    const credits = matches.reduce((n, m) => n + m.credits, 0);
    const byCredits = group.credits ? credits >= group.credits : null;
    const byCount = group.minCourses || group.choose ? matches.length >= (group.minCourses || group.choose) : null;
    if (byCredits !== null && byCount !== null) return byCredits && byCount;
    if (byCredits !== null) return byCredits;
    if (byCount !== null) return byCount;
    return group.courses && matches.length >= group.courses.length;
  };

  return (program.groups || []).filter((g) => g.kind !== 'total').map((group) => {
    const matches = [];
    // listed courses first, so an area's own courses aren't crowded out by overflow
    const ordered = planned.slice().sort((a, b) => Number((group.courses || []).includes(b.code)) - Number((group.courses || []).includes(a.code)));
    for (const course of ordered) {
      if (used.has(course.code) || !accepts(group, course) || full(group, matches)) continue;
      if (course.grade && ['F', 'NA', 'W', 'U'].includes(course.grade)) continue;
      matches.push({ ...course, credits: creditsOf(course, group), ects: ectsOf(course) });
      used.add(course.code);
    }
    const doneCredits = matches.reduce((n, m) => n + m.credits, 0);
    const ects = matches.reduce((n, m) => n + (m.ects || 0), 0);
    return {
      group,
      matches,
      doneCredits,
      ects,
      earned: earnedCredits(matches),
      target: group.credits || null,
      targetCount: group.minCourses || group.choose || (group.courses && !group.credits ? group.courses.length : null),
      missing: group.kind === 'required' || group.kind === 'university'
        ? (group.courses || []).filter((c) => !matches.some((m) => m.code === c))
        : [],
    };
  });
}

/** Required and core courses of the chosen programme — seniors may take these on day one. */
function seniorDayOneCodes() {
  const program = currentProgram();
  if (!program) return new Set();
  return new Set((program.groups || []).filter((g) => g.kind === 'required' || g.kind === 'core')
    .flatMap((g) => g.courses || []));
}

function termOptions(selected) {
  const plan = planState();
  const years = new Set();
  const thisYear = Number((App.index?.terms?.[0]?.code || `${new Date().getFullYear()}01`).slice(0, 4));
  for (let y = thisYear - 6; y <= thisYear + 3; y += 1) years.add(y);
  plan.terms.forEach((t) => years.add(Number(t.id.slice(0, 4))));
  const ids = [];
  [...years].sort().forEach((y) => ['01', '02', '03'].forEach((p) => ids.push(`${y}${p}`)));
  return ids.map((id) => `<option value="${id}"${id === selected ? ' selected' : ''}
    ${plan.terms.some((t) => t.id === id) ? ' disabled' : ''}>${esc(termLabel(id))}</option>`).join('');
}

function suggestedTermId() {
  const plan = planState();
  if (plan.terms.length) return nextTerm(plan.terms[plan.terms.length - 1].id);
  return App.index?.terms?.[0]?.code || '202601';
}

function renderPlanner() {
  const host = $('#plan-body');
  if (!host) return;
  const plan = planState();
  const program = currentProgram();
  const planned = allPlanned();
  const overall = gpaOf(planned);
  const earned = earnedCredits(planned);

  const programOptions = ['<option value="">No programme</option>'].concat((App.programs || []).map((p) =>
    `<option value="${esc(p.code)}"${p.code === plan.program ? ' selected' : ''}>${esc(p.name)}${p.legacy ? '' : ` (${esc(p.code)})`}</option>`)).join('');
  const listed = (App.programs || []).find((p) => p.code === plan.program);
  const entryOptions = listed && !listed.legacy ? listed.entries.map((id) =>
    `<option value="${esc(id)}"${id === (program && program.entry) ? ' selected' : ''}>Entered ${esc(termLabel(id))}</option>`).join('') : '';

  const stats = [
    overall ? `<span class="stat">CGPA <b>${overall.gpa.toFixed(2)}</b></span>` : '',
    earned ? `<span class="stat"><b>${earned}</b> SU credits earned</span>` : '',
    `<span class="stat"><b>${planned.length}</b> course${planned.length === 1 ? '' : 's'} planned</span>`,
  ].filter(Boolean).join('');

  const progress = program ? requirementProgress(program) : [];
  const reqHTML = program ? `
    ${program.example ? '<p class="banner" style="margin-bottom:10px">Example programme data — replace data/programs.json with your own.</p>' : ''}
    ${program.totalCredits ? `<p class="cat-sub">Graduation needs ${esc(program.totalCredits)} SU credits${program.totalEcts ? ` and ${esc(program.totalEcts)} ECTS` : ''}${program.entry && program.entry !== 'any' ? ` for students who entered in ${esc(termLabel(program.entry))}` : ''}.</p>` : ''}
    <div class="req-grid">${progress.map(({ group, matches, doneCredits, earned: got, target, targetCount, missing, ects }) => {
      const parts = [];
      if (target) parts.push(`${doneCredits}/${target} cr`);
      if (targetCount && (group.minCourses || !target)) parts.push(`${matches.length}/${targetCount} courses`);
      if (group.ects && ects) parts.push(`${ects}/${group.ects} ECTS`);
      const label = parts.join(', ') || `${matches.length} courses`;
      const ratio = target ? Math.min(1, doneCredits / target) : targetCount ? Math.min(1, matches.length / targetCount) : 1;
      const earnedRatio = target ? Math.min(1, got / target) : 0;
      return `<div class="req-card">
        <div class="req-top"><b>${esc(group.name)}</b><span>${esc(label)}</span></div>
        <div class="bar"><span style="width:${Math.round(ratio * 100)}%"></span>
          ${earnedRatio ? `<i style="width:${Math.round(earnedRatio * 100)}%"></i>` : ''}</div>
        ${missing.length && missing.length <= 8 ? `<p class="req-missing">Left: ${missing.map((c) => esc(c)).join(', ')}</p>` : ''}
      </div>`;
    }).join('')}</div>` : '<p class="empty-note">No programme loaded. Put a curriculum in data/programs.json (tools/import_program.py builds one) to track requirements.</p>';

  host.innerHTML = `
    <div class="filters">
      <select class="select" id="plan-program" aria-label="Programme">${programOptions}</select>
      ${entryOptions ? `<select class="select" id="plan-entry" aria-label="Entry term">${entryOptions}</select>` : ''}
      <button class="btn" type="button" id="plan-import">Import transcript</button>
      ${program && program.suggested ? '<button class="btn" type="button" id="plan-fill">Fill suggested plan</button>' : ''}
      <button class="btn quiet" type="button" id="plan-clear">Clear plan</button>
      ${stats}
    </div>
    ${reqHTML}
    <div class="plan-grid">
      ${plan.terms.map((term) => {
        const courses = term.courses.map(courseFacts);
        const termGpa = gpaOf(courses);
        const credits = courses.reduce((n, c) => n + (c.credits || 0), 0);
        return `<div class="sem-card" data-term="${esc(term.id)}">
          <div class="sem-head">
            <b>${esc(termLabel(term.id))}</b>
            <span>${credits ? `${credits} cr` : `${courses.length} course${courses.length === 1 ? '' : 's'}`}${termGpa ? ` · ${termGpa.gpa.toFixed(2)}` : ''}
              <button type="button" class="sem-x" data-drop-term="${esc(term.id)}" aria-label="Remove ${esc(termLabel(term.id))}">✕</button></span>
          </div>
          ${courses.map((course) => {
            const issues = planIssues(term.id, course);
            return `<div class="sem-row${issues.length ? ' warn' : ''}">
              <button type="button" class="sem-code" data-open="${esc(course.code)}">${esc(course.code)}</button>
              <span class="sem-title">${esc(course.title)}</span>
              <span class="sem-cr">${course.credits ?? '—'}</span>
              <select class="grade-select" data-grade="${esc(course.code)}" aria-label="Grade for ${esc(course.code)}">
                ${GRADE_OPTIONS.map((g) => `<option value="${g}"${g === course.grade ? ' selected' : ''}>${g || '–'}</option>`).join('')}
              </select>
              <button type="button" class="sem-x" data-remove="${esc(course.code)}" aria-label="Remove ${esc(course.code)}">✕</button>
              ${issues.length ? `<span class="sem-issue">${esc(issues.join('; '))}</span>` : ''}
            </div>`;
          }).join('')}
          ${App.addingTo === term.id
            ? `<div class="sem-add"><input type="search" class="sem-input" id="sem-input" placeholder="Course code" autocomplete="off">
               <div class="sem-results" id="sem-results"></div></div>`
            : `<button type="button" class="sem-plus" data-add="${esc(term.id)}">+ Add course</button>`}
        </div>`;
      }).join('')}
      <div class="sem-card add-term">
        <div class="sem-head"><b>Add a term</b></div>
        <select class="select" id="new-term">${termOptions(suggestedTermId())}</select>
        <button class="btn" type="button" id="plan-add-term" style="margin-top:8px;width:100%">Add term</button>
      </div>
    </div>`;

  if (App.addingTo) {
    const input = $('#sem-input');
    if (input) {
      input.focus();
      input.oninput = () => {
        const results = searchUnion(input.value);
        $('#sem-results').innerHTML = results.map((c) =>
          `<button type="button" class="res" data-pick="${esc(c.code)}">
            <span class="res-code">${esc(c.code)}</span><span class="res-title">${esc(c.title || '')}</span>
            <span class="res-tag">${c.credits ?? ''}</span></button>`).join('')
          || `<button type="button" class="res" data-pick="${esc(input.value.trim().toUpperCase())}">
               <span class="res-code">${esc(input.value.trim().toUpperCase())}</span>
               <span class="res-title">add anyway</span></button>`;
      };
      input.onkeydown = (e) => {
        if (e.key === 'Escape') { App.addingTo = null; renderPlanner(); }
        if (e.key === 'Enter') {
          const first = $('#sem-results .res');
          if (first) addToTerm(App.addingTo, first.dataset.pick);
        }
      };
    }
  }
}

function addTerm(id) {
  const plan = planState();
  if (!id || plan.terms.some((t) => t.id === id)) return;
  plan.terms.push({ id, courses: [] });
  plan.terms.sort((a, b) => a.id.localeCompare(b.id));
  save();
  renderPlanner();
}

function addToTerm(id, code, extra = {}) {
  if (!code) return;
  const term = planTerm(id) || (addTerm(id), planTerm(id));
  if (!term) return;
  const existing = term.courses.find((c) => c.code === code);
  if (existing) Object.assign(existing, extra);
  else term.courses.push({ code, ...extra });
  save();
  renderPlanner();
  const input = $('#sem-input');
  if (input) { input.value = ''; input.focus(); $('#sem-results').innerHTML = ''; }
}

function removeFromTerm(id, code) {
  const term = planTerm(id);
  if (!term) return;
  term.courses = term.courses.filter((c) => c.code !== code);
  save();
  renderPlanner();
}

function setGrade(id, code, grade) {
  const term = planTerm(id);
  const course = term && term.courses.find((c) => c.code === code);
  if (!course) return;
  if (grade) course.grade = grade; else delete course.grade;
  save();
  renderPlanner();
}

function fillSuggested() {
  const program = currentProgram();
  if (!program || !program.suggested) return;
  const plan = planState();
  let id = plan.terms.length ? plan.terms[0].id : suggestedTermId();
  const keys = Object.keys(program.suggested).sort();
  keys.forEach((key, i) => {
    if (i) id = nextTerm(id);
    program.suggested[key].forEach((code) => addToTerm(id, code));
  });
  toast('Suggested plan filled in');
}

/* ------------------------------------------------------- transcript import */

/** Text of a BannerWeb "Academic Records Summary", whether it came from HTML or PDF. */
function parseTranscript(text) {
  const flat = ` ${String(text).replace(/\s+/g, ' ')} `;
  const termRe = /\b(Fall|Spring|Summer|Güz|Bahar|Yaz)\s*(\d{4})\s*-\s*(\d{4})\b/g;
  // PDF text extraction glues columns together ("MATH 101Calculus I", "Science of Nature IUG"),
  // so every gap here is optional and the course number refuses a letter that starts a word.
  const rowRe = /\b([A-Z]{2,6})\s?(\d{3}[A-Z]?(?![a-z]))\s*(.+?)\s*(UG|FDY|MA|DR|SP)\s+(A-|A|B\+|B-|B|C\+|C-|C|D\+|D|F|S|U|SL|EL|P|W|NA|I|T)?\s*(\d+\.\d{2})\s*(\d+\.\d{2})/g;
  const season = { fall: '01', güz: '01', guz: '01', spring: '02', bahar: '02', summer: '03', yaz: '03' };

  const marks = [];
  let m;
  while ((m = termRe.exec(flat)) !== null) {
    marks.push({ at: m.index, id: `${m[2]}${season[m[1].toLowerCase()] || '01'}` });
  }
  if (!marks.length) return { terms: [], courses: 0 };

  const terms = new Map();
  marks.forEach((mark, i) => {
    const chunk = flat.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : flat.length);
    rowRe.lastIndex = 0;
    let row;
    while ((row = rowRe.exec(chunk)) !== null) {
      const [, subject, number, title, , grade, credit, ects] = row;
      const code = `${subject} ${number}`;
      if (!terms.has(mark.id)) terms.set(mark.id, new Map());
      terms.get(mark.id).set(code, {
        code,
        title: clean(title),
        credits: Number(credit),
        ects: Number(ects),
        grade: grade || '',
      });
    }
  });

  const programs = [...flat.matchAll(/Program\s*:\s*([^(]+?)\s*\(/g)].map((x) => clean(x[1]))
    .filter((name) => !/^Programs of/i.test(name));
  const out = [...terms.entries()]
    .map(([id, courses]) => ({ id, courses: [...courses.values()] }))
    .filter((t) => t.courses.length)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { terms: out, courses: out.reduce((n, t) => n + t.courses.length, 0), program: programs[programs.length - 1] || null };
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((node) => node.remove());
  const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node = walker.nextNode();
  while (node) {
    parts.push(node.nodeValue);
    node = walker.nextNode();
  }
  return parts.join(' ');
}

const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!loadPdfJs.promise) {
    loadPdfJs.promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_SRC;
      script.onload = () => {
        const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
        if (!lib) { reject(new Error('pdf.js did not load')); return; }
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(lib);
      };
      script.onerror = () => reject(new Error('pdf.js could not be fetched'));
      document.head.appendChild(script);
    });
  }
  return loadPdfJs.promise;
}

async function pdfToText(file) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await pdf.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return pages.join(' ');
}

function openImportDialog() {
  App.transcript = null;
  $('#import-body').innerHTML = `
    <p>Take your Academic Records Summary from BannerWeb — save the page as HTML, or print it to PDF —
       and open it here. The file is read inside this browser tab; nothing is uploaded anywhere, and your
       name and student number are not read out of it.</p>
    <input type="file" id="import-file" accept=".html,.htm,.pdf,text/html,application/pdf">
    <div id="import-preview"></div>`;
  $('#import-apply').disabled = true;
  $('#dlg-import').showModal();
}

async function handleTranscriptFile(file) {
  const preview = $('#import-preview');
  preview.innerHTML = '<p class="cat-sub">Reading…</p>';
  try {
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const text = isPdf ? await pdfToText(file) : htmlToText(await file.text());
    const parsed = parseTranscript(text);
    App.transcript = parsed;
    if (!parsed.terms.length) {
      preview.innerHTML = '<p class="course-note clash">No course rows recognised in that file. If it came from somewhere other than the Academic Records Summary, try that page instead.</p>';
      $('#import-apply').disabled = true;
      return;
    }
    preview.innerHTML = `
      <p class="cat-sub">${parsed.courses} courses across ${parsed.terms.length} term${parsed.terms.length === 1 ? '' : 's'}:</p>
      <div class="import-list">${parsed.terms.map((t) => `<div class="import-row">
        <b>${esc(termLabel(t.id))}</b>
        <span>${t.courses.map((c) => esc(c.code)).join(', ')}</span></div>`).join('')}</div>
      <label class="opt"><input type="checkbox" id="import-grades" checked><span>Bring the grades in too</span></label>
      <label class="opt"><input type="checkbox" id="import-replace"><span>Replace what's in my plan</span></label>`;
    $('#import-apply').disabled = false;
  } catch (err) {
    preview.innerHTML = `<p class="course-note clash">${esc(err.message || 'Could not read that file')}</p>`;
    $('#import-apply').disabled = true;
  }
}

function applyTranscript() {
  const parsed = App.transcript;
  if (!parsed) return;
  const withGrades = $('#import-grades') ? $('#import-grades').checked : true;
  const replace = $('#import-replace') ? $('#import-replace').checked : false;
  const plan = planState();
  if (replace) plan.terms = [];
  for (const term of parsed.terms) {
    for (const course of term.courses) {
      addToTerm(term.id, course.code, {
        title: course.title,
        credits: course.credits,
        ects: course.ects,
        ...(withGrades && course.grade ? { grade: course.grade } : {}),
      });
    }
  }
  // pick the programme and entry term the transcript points to, if nothing is chosen yet
  if (parsed.program && !plan.program && App.programs) {
    const wanted = fold(parsed.program);
    const match = App.programs.find((p) => fold(p.name).includes(wanted) || wanted.includes(fold(p.name)));
    if (match) {
      plan.program = match.code;
      plan.entry = parsed.terms[0] ? parsed.terms[0].id : null;
    }
  }
  save();
  refreshRequirements();
  toast(`${parsed.courses} courses imported${plan.program ? '' : ''}`);
}

/* --------------------------------------------------------------- today view */

function renderToday() {
  const host = $('#today-body');
  if (!host) return;
  const now = istanbulNow();
  const all = planBlocks();
  const today = all.filter((b) => b.day === now.day).sort((a, b) => a.start - b.start);
  const dateLine = new Date(`${istanbulToday()}T12:00:00`)
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const status = (b) => {
    if (now.min >= b.end) return { label: 'done', cls: 'past' };
    if (now.min >= b.start) return { label: `ends ${hhmm(b.end)}`, cls: 'live' };
    const wait = b.start - now.min;
    return { label: wait < 90 ? `in ${durText(wait)}` : `at ${hhmm(b.start)}`, cls: '' };
  };

  let next = null;
  if (!today.some((b) => b.end > now.min)) {
    for (let step = 1; step <= 7 && !next; step += 1) {
      const day = (now.day + step) % 7;
      const candidates = all.filter((b) => b.day === day).sort((a, b) => a.start - b.start);
      if (candidates.length) next = { block: candidates[0], day };
    }
  }

  const finals = App.exams
    ? examPlan().rows.filter(({ exam }) => exam.date === istanbulToday())
    : [];

  host.innerHTML = `
    <p class="today-date">${esc(dateLine)}</p>
    ${today.length ? today.map((b) => {
      const s = status(b);
      return `<div class="today-row ${s.cls}">
        <span class="today-time">${esc(hhmm(b.start))}<small>${esc(hhmm(b.end))}</small></span>
        <span class="today-main">
          <span class="today-code c${b.color}">${esc(b.code)}${b.group && b.group !== '0' ? ` ${esc(b.group)}` : ''}</span>
          <span class="today-where">${esc(b.where || 'room not listed')}</span>
        </span>
        <span class="today-status">${esc(s.label)}</span>
      </div>`;
    }).join('')
    : `<p class="empty-note">${tt().order.length ? 'No classes today.' : 'Add courses in the Timetable tab and today\'s classes show up here.'}</p>`}
    ${next ? `<p class="cat-sub">Next up: ${esc(next.block.code)} on ${esc(DAYS_FULL[next.day])} at ${esc(hhmm(next.block.start))}${next.block.where ? `, ${esc(next.block.where)}` : ''}.</p>` : ''}
    ${finals.length ? `<h3 class="side-head" style="margin-top:18px">Exam today</h3>${finals.map(({ exam, sec }) =>
      `<div class="final-row"><span class="final-code c${(entry(sec.course.code) || {}).color || 0}">${esc(sec.course.code)}</span>
       <span>${exam.start !== null && exam.start !== undefined ? esc(hhmm(exam.start)) : 'time in BannerWeb'}</span>
       <span class="final-where">${esc(exam.place || '')}</span></div>`).join('')}` : ''}`;
}

/* --------------------------------------------------------------- rooms view */

function roomList() {
  return [...App.idx.rooms.keys()].filter(Boolean).sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));
}

function buildingOf(place) {
  const parts = place.split(' ');
  return parts.length > 1 ? parts.slice(0, -1).join(' ') : place;
}

function renderRooms() {
  const filter = fold($('#room-search').value.trim());
  const day = Number($('#room-day').value);
  const time = Number($('#room-time').value);
  const rooms = roomList();
  const busy = new Set();
  rooms.forEach((r) => {
    for (const { m } of App.idx.rooms.get(r)) {
      if (m.day === day && m.start < time + 50 && time < m.end) { busy.add(r); break; }
    }
  });
  const free = rooms.filter((r) => !busy.has(r) && (!filter || fold(r).includes(filter)));
  const byBuilding = new Map();
  free.forEach((r) => {
    const b = buildingOf(r);
    if (!byBuilding.has(b)) byBuilding.set(b, []);
    byBuilding.get(b).push(r);
  });
  $('#room-free').innerHTML = `<p class="cat-sub">${free.length} room${free.length === 1 ? '' : 's'} with no scheduled class on ${DAYS_FULL[day]} at ${hhmm(time)}.</p>`
    + [...byBuilding.entries()].map(([b, rs]) => `<div class="building">${esc(b)}</div><div class="room-list">${
      rs.map((r) => `<button class="room-btn" type="button" data-room="${esc(r)}" aria-pressed="${App.room === r}">${esc(r.replace(b, '').trim() || r)}</button>`).join('')
    }</div>`).join('');

  const wrap = $('#room-grid-wrap');
  if (!App.room) { wrap.innerHTML = '<p class="empty-note">Pick a room to see its week.</p>'; return; }
  const meetings = App.idx.rooms.get(App.room) || [];
  const blocks = meetings.map(({ sec, m }, i) => ({
    id: `r:${i}`, kind: 'room', day: m.day, start: m.start, end: m.end,
    color: Math.abs([...sec.course.subj].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)) % COLORS,
    code: sec.component.code, group: sec.group, where: sec.people[0] || '',
  }));
  wrap.innerHTML = `<h3 class="building">${esc(App.room)} — ${meetings.length} class${meetings.length === 1 ? '' : 'es'} a week</h3><div class="card grid-card" id="room-grid"></div>`;
  renderGrid($('#room-grid'), blocks, { orientation: orientation(), nowLine: true });
}

/* --------------------------------------------------------------- CRN dialog */

function crnRows() {
  const rows = [];
  for (const code of tt().order) {
    const e = tt().courses[code];
    const course = App.idx.byCode.get(code);
    if (!e || e.hidden || !course) continue;
    const reg = registrationDay(code);
    for (const comp of course.components) {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      if (sec) rows.push({ crn: sec.crn, label: `${comp.code} ${sec.group}`, day: reg && reg.day });
    }
  }
  return rows;
}

function openCrnDialog() {
  const rows = crnRows();
  const dlg = $('#dlg-crn');
  $('#crn-body').innerHTML = `
    <p>Tap a CRN to copy it — BannerWeb's add/drop worksheet takes them one box at a time.</p>
    <div class="crn-list">${(() => {
      if (!rows.length) return '<p class="empty-note">No courses in this timetable yet.</p>';
      const grouped = App.regdays && myPrograms().length;
      const buckets = grouped ? [1, 2, 3, null] : [undefined];
      return buckets.map((day) => {
        const list = grouped ? rows.filter((r) => (r.day || null) === day) : rows;
        if (!list.length) return '';
        const heading = !grouped ? '' : `<h3 class="side-head">${day ? `Day ${day}` : 'Not on the registration list'}</h3>`;
        return heading + list.map((r) => `<button class="crn-row" type="button" data-crn="${esc(r.crn)}">
          <span class="crn-num">${esc(r.crn)}</span><span class="crn-for">${esc(r.label)}</span>${seatBadge(r.crn)}<span class="crn-copy">copy</span>
        </button>`).join('');
      }).join('');
    })()}</div>
    ${rows.length ? '<button class="btn" id="crn-copy-all" type="button">Copy the whole list</button>' : ''}
    <p style="margin-top:16px">Or paste CRNs from a friend to load their timetable:</p>
    <textarea class="paste" id="crn-paste" placeholder="10190 10195 10842"></textarea>
    <div class="dlg-foot" style="padding-left:0;padding-right:0">
      <button class="btn primary" id="crn-load" type="button">Load these CRNs</button>
    </div>`;
  dlg.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function loadCrns(text, { silent = false } = {}) {
  const crns = (text.match(/\d{5}/g) || []);
  if (!crns.length) { toast('No CRNs found in that text'); return; }
  pushUndo('load CRNs');
  const t = tt();
  let added = 0, missing = 0;
  for (const crn of crns) {
    const sec = App.idx.byCrn.get(crn);
    if (!sec) { missing += 1; continue; }
    const code = sec.course.code;
    if (!t.courses[code]) {
      t.courses[code] = { color: nextColor(), hidden: false, sel: {} };
      t.order.push(code);
      added += 1;
    }
    t.courses[code].sel[sec.component.type] = crn;
  }
  // fill components the list didn't mention
  for (const code of t.order) {
    const course = App.idx.byCode.get(code);
    const e = t.courses[code];
    for (const comp of course.components) {
      if (e.sel[comp.type] && App.idx.byCrn.has(e.sel[comp.type])) continue;
      const lecture = App.idx.byCrn.get(e.sel['']);
      const options = compatibleSections(course, comp, lecture);
      const occupied = occupiedMeetings(code);
      let pick = options[0], best = Infinity;
      options.forEach((s, i) => {
        const score = clashMinutes(s.meetings, occupied) * 100 + i;
        if (score < best) { pick = s; best = score; }
      });
      if (pick) e.sel[comp.type] = pick.crn;
    }
  }
  save();
  render();
  if (!silent) toast(`${added} course${added === 1 ? '' : 's'} loaded${missing ? `, ${missing} CRN${missing === 1 ? '' : 's'} not in ${App.idx.name}` : ''}`,
    { action: 'Undo', onAction: undo });
}

/* ------------------------------------------------------------ the arranger */

function optimise(opts) {
  const codes = tt().order.filter((c) => !tt().courses[c].hidden && App.idx.byCode.has(c));
  if (!codes.length) return { results: [], empty: true };

  const sets = codes.map((code) => {
    const course = App.idx.byCode.get(code);
    const current = tt().courses[code].sel;
    const combos = courseCombos(course, { current, keepLecture: opts.keepLecture, limit: 1500 });
    combos.forEach((cb) => {
      cb.code = code;
      cb.changes = Object.keys(cb.sel).filter((k) => cb.sel[k] !== current[k]).length;
      cb.days = new Set(cb.meetings.map((m) => m.day)).size;
      cb.early = cb.meetings.filter((m) => m.start < (opts.earliest || 0)).length;
    });
    combos.sort((a, b) => a.penalty - b.penalty || a.days - b.days || a.early - b.early || a.changes - b.changes);
    return combos;
  });
  const order = sets.map((s, i) => i).sort((a, b) => sets[a].length - sets[b].length);

  const W = {
    clash: 200000, full: 400000, link: 40000, freeDay: 9000, early: 2500, late: 2500, lunch: 1500,
    day: opts.fewerDays ? 1200 : 0, gap: opts.fewerGaps ? 1 : 0, change: 10,
  };
  const dayBusy = [[], [], [], [], [], [], []];
  customMeetings().forEach((m) => dayBusy[m.day].push(m));
  const picks = new Array(sets.length);
  let clashes = 0;
  let nodes = 0;
  const KEEP = 6;
  const LIMIT = 260000;
  const results = [];
  let cutoff = Infinity;

  const add = (cb) => {
    let extra = 0;
    for (const m of cb.meetings) {
      for (const o of dayBusy[m.day]) if (m.start < o.end && o.start < m.end) extra += 1;
      dayBusy[m.day].push(m);
    }
    clashes += extra;
    return extra;
  };
  const remove = (cb, extra) => {
    for (const m of cb.meetings) {
      const list = dayBusy[m.day];
      const i = list.indexOf(m);
      if (i >= 0) list.splice(i, 1);
    }
    clashes -= extra;
  };

  const measure = () => {
    const stats = { clashes, days: 0, earliest: null, latest: null, gap: 0, freeDayMisses: [], early: 0, late: 0, lunch: 0 };
    for (let d = 0; d < 7; d += 1) {
      const list = dayBusy[d].slice().sort((a, b) => a.start - b.start);
      if (!list.length) continue;
      stats.days += 1;
      if (opts.freeDays && opts.freeDays.includes(d)) stats.freeDayMisses.push(d);
      const first = list[0].start;
      const last = list.reduce((x, m) => Math.max(x, m.end), 0);
      stats.earliest = stats.earliest === null ? first : Math.min(stats.earliest, first);
      stats.latest = stats.latest === null ? last : Math.max(stats.latest, last);
      if (opts.earliest && first < opts.earliest) stats.early += 1;
      if (opts.latest && last > opts.latest) stats.late += 1;
      if (opts.lunch) {
        const busyAtLunch = list.some((m) => m.start < opts.lunch[1] && opts.lunch[0] < m.end);
        if (busyAtLunch) stats.lunch += 1;
      }
      let end = null;
      for (const m of list) {
        if (end !== null && m.start > end) stats.gap += Math.max(0, m.start - end - 10);
        end = end === null ? m.end : Math.max(end, m.end);
      }
    }
    return stats;
  };

  const scoreOf = (stats, chosen) => stats.clashes * W.clash
    + chosen.reduce((n, cb) => n + (cb ? cb.full : 0), 0) * W.full
    + chosen.reduce((n, cb) => n + (cb ? cb.penalty : 0), 0) * W.link
    + stats.freeDayMisses.length * W.freeDay
    + stats.early * W.early + stats.late * W.late + stats.lunch * W.lunch
    + stats.days * W.day + stats.gap * W.gap
    + chosen.reduce((n, cb) => n + (cb ? cb.changes : 0), 0) * W.change;

  const lowerBound = () => clashes * W.clash
    + (opts.freeDays || []).filter((d) => dayBusy[d].length).length * W.freeDay
    + [0, 1, 2, 3, 4, 5, 6].filter((d) => dayBusy[d].length).length * W.day;

  const dfs = (i) => {
    if (nodes > LIMIT) return;
    if (i === order.length) {
      const stats = measure();
      const score = scoreOf(stats, picks);
      const signature = picks.map((cb) => Object.values(cb.sel).join('.')).join('|');
      if (results.some((r) => r.signature === signature)) return;
      results.push({ signature, score, stats, picks: picks.map((cb) => ({ code: cb.code, sel: { ...cb.sel } })) });
      results.sort((a, b) => a.score - b.score);
      results.length = Math.min(results.length, KEEP);
      if (results.length === KEEP) cutoff = results[KEEP - 1].score;
      return;
    }
    if (lowerBound() > cutoff) return;
    for (const cb of sets[order[i]]) {
      nodes += 1;
      if (nodes > LIMIT) return;
      const extra = add(cb);
      picks[order[i]] = cb;
      dfs(i + 1);
      remove(cb, extra);
      picks[order[i]] = null;
    }
  };
  dfs(0);

  return { results, limited: nodes > LIMIT };
}

function applyOption(result, label) {
  pushUndo('optimise');
  result.picks.forEach((pick) => { tt().courses[pick.code].sel = { ...pick.sel }; });
  save();
  render();
  toast(label || 'Timetable updated', { action: 'Undo', onAction: undo });
}

function optionSummary(stats) {
  const bits = [`${stats.days} day${stats.days === 1 ? '' : 's'}`];
  if (stats.earliest !== null) bits.push(`${hhmm(stats.earliest)}–${hhmm(stats.latest)}`);
  bits.push(stats.gap ? `${durText(stats.gap)} gaps` : 'no gaps');
  return bits;
}

function runOptimiser() {
  const opts = {
    keepLecture: $('#opt-keep').checked,
    fewerGaps: $('#opt-gaps').checked,
    fewerDays: $('#opt-days').checked,
    earliest: Number($('#opt-earliest').value) || 0,
    latest: Number($('#opt-latest').value) || 0,
    lunch: $('#opt-lunch').checked ? [12 * 60 + 40, 13 * 60 + 30] : null,
    freeDays: $$('#dlg-arrange [data-day][aria-pressed="true"]').map((b) => Number(b.dataset.day)),
  };
  const host = $('#arrange-results');
  host.innerHTML = '<p class="cat-sub">Working through the combinations…</p>';
  setTimeout(() => {
    const { results, empty, limited } = optimise(opts);
    if (empty) { host.innerHTML = '<p class="empty-note">Add courses to your timetable first.</p>'; return; }
    if (!results.length) { host.innerHTML = '<p class="empty-note">No combination found.</p>'; return; }
    App.options = results;
    host.innerHTML = `<h3 class="side-head">${results.length} option${results.length === 1 ? '' : 's'}${limited ? ' (search cut short)' : ''}</h3>`
      + results.map((r, i) => {
        const flags = [];
        if (r.stats.clashes) flags.push(`${r.stats.clashes} clash${r.stats.clashes === 1 ? '' : 'es'}`);
        const fullCount = r.picks.reduce((n, pick) => n + Object.values(pick.sel).filter((crn) => { const s = seatInfo(crn); return s && s.remaining <= 0; }).length, 0);
        if (fullCount) flags.push(`${fullCount} full section${fullCount === 1 ? '' : 's'}`);
        r.stats.freeDayMisses.forEach((d) => flags.push(`${DAYS[d]} not free`));
        if (r.stats.early) flags.push('early start');
        if (r.stats.late) flags.push('late finish');
        if (r.stats.lunch) flags.push('lunch taken');
        return `<button type="button" class="option" data-option="${i}">
          <span class="option-rank">${i + 1}</span>
          <span class="option-main">
            <span class="option-stats">${optionSummary(r.stats).map((b) => `<span>${esc(b)}</span>`).join('')}</span>
            ${flags.length ? `<span class="option-flags">${esc(flags.join(', '))}</span>` : '<span class="option-ok">everything you asked for</span>'}
          </span>
          <span class="option-use">Use</span>
        </button>`;
      }).join('');
  }, 20);
}

/* ------------------------------------------------------------- custom events */

function openEventDialog(id) {
  const ev = customEvents().find((x) => x.id === id) || { id: null, title: '', day: 0, start: 17 * 60 + 40, end: 19 * 60 + 30, place: '', color: 7 };
  App.editingEvent = ev.id;
  $('#event-title').value = ev.title;
  $('#event-day').innerHTML = DAYS.slice(0, 6).map((d, i) => `<option value="${i}"${i === ev.day ? ' selected' : ''}>${DAYS_FULL[i]}</option>`).join('');
  $('#event-start').value = hhmm(ev.start);
  $('#event-end').value = hhmm(ev.end);
  $('#event-place').value = ev.place || '';
  $('#event-colors').innerHTML = Array.from({ length: COLORS }, (_, i) =>
    `<button type="button" class="c${i}" data-color="${i}" aria-pressed="${i === (ev.color ?? 7)}" aria-label="Colour ${i + 1}"></button>`).join('');
  $('#event-delete').hidden = !ev.id;
  $('#dlg-event').showModal();
  setTimeout(() => $('#event-title').focus(), 30);
}

function saveEvent() {
  const toMinutes = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const title = $('#event-title').value.trim() || 'Event';
  const start = toMinutes($('#event-start').value || '17:40');
  const end = toMinutes($('#event-end').value || '19:30');
  if (end <= start) { toast('The event has to end after it starts'); return false; }
  const swatch = $('#event-colors [aria-pressed="true"]');
  const color = swatch ? Number(swatch.dataset.color) : 7;
  pushUndo('event');
  const list = customEvents();
  const data = { title, day: Number($('#event-day').value), start, end, place: $('#event-place').value.trim(), color };
  const existing = App.editingEvent && list.find((x) => x.id === App.editingEvent);
  if (existing) Object.assign(existing, data);
  else list.push({ id: `e${Date.now().toString(36)}`, ...data });
  save();
  render();
  return true;
}

/* ------------------------------------------------------------ calendar export */

const ICS_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function icsStamp(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}T${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}00`;
}

const icsDay = (date) => date.replace(/-/g, '');

function nextIsoDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** First `day` (0 = Monday) on or after an ISO date. */
function firstDayOnOrAfter(isoDate, day) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((day - ((d.getUTCDay() + 6) % 7) + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function foldLine(line) {
  const out = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function buildICS({ start, end, classes = true, finals = true, reminders = false }) {
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const holidays = (App.calendar && App.calendar.holidays) || [];
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SUMods//Sabanci timetable//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`SUMods ${App.idx.name}`)}`, 'X-WR-TIMEZONE:Europe/Istanbul',
    // Türkiye has kept a single +03 offset since 2016, so one standard component is enough
    'BEGIN:VTIMEZONE', 'TZID:Europe/Istanbul', 'BEGIN:STANDARD', 'DTSTART:20160908T000000',
    'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300', 'TZNAME:+03', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  const weekly = (uid, day, from, to, summary, place, description) => {
    const first = firstDayOnOrAfter(start, day);
    if (first > end) return;
    const skip = holidays.filter((h) => h.date >= start && h.date <= end
      && (new Date(`${h.date}T00:00:00Z`).getUTCDay() + 6) % 7 === day);
    lines.push('BEGIN:VEVENT', `UID:${uid}@sumods`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Istanbul:${icsStamp(first, from)}`,
      `DTEND;TZID=Europe/Istanbul:${icsStamp(first, to)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAYS[day]};UNTIL=${icsDay(end)}T235900Z`,
      ...(skip.length ? [foldLine(`EXDATE;TZID=Europe/Istanbul:${skip.map((h) => icsStamp(h.date, from)).join(',')}`)] : []),
      foldLine(`SUMMARY:${icsText(summary)}`),
      ...(place ? [foldLine(`LOCATION:${icsText(place)}`)] : []),
      ...(description ? [foldLine(`DESCRIPTION:${icsText(description)}`)] : []),
      'END:VEVENT');
  };

  if (classes) {
    for (const code of tt().order) {
      const e = tt().courses[code];
      const course = App.idx.byCode.get(code);
      if (!e || e.hidden || !course) continue;
      for (const comp of course.components) {
        const sec = App.idx.byCrn.get(e.sel[comp.type]);
        if (!sec) continue;
        sec.meetings.forEach((m, i) => weekly(`${sec.crn}-${i}-${App.idx.term}`, m.day, m.start, m.end,
          `${comp.code} ${sec.group}`, m.place, `${course.title}\nCRN ${sec.crn}${sec.people.length ? `\n${sec.people.join(', ')}` : ''}`));
      }
    }
    customEvents().filter((ev) => !ev.hidden).forEach((ev) =>
      weekly(`${ev.id}-${App.idx.term}`, ev.day, ev.start, ev.end, ev.title, ev.place, ''));
  }

  if (reminders && App.calendar && App.calendar.registrationDays) {
    const allDay = (uid, date, until, summary, description) => lines.push('BEGIN:VEVENT', `UID:${uid}@sumods`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDay(date)}`, `DTEND;VALUE=DATE:${icsDay(nextIsoDay(until))}`,
      foldLine(`SUMMARY:${icsText(summary)}`), ...(description ? [foldLine(`DESCRIPTION:${icsText(description)}`)] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=START:PT9H', foldLine(`DESCRIPTION:${icsText(summary)}`), 'END:VALARM',
      'END:VEVENT');
    App.calendar.registrationDays.forEach((date, i) => {
      const due = crnRows().filter((r) => r.day === i + 1);
      allDay(`regday-${i + 1}-${App.idx.term}`, date, date,
        `Registration day ${i + 1}${due.length ? ` — ${due.length} CRN${due.length === 1 ? '' : 's'}` : ''}`,
        due.length ? due.map((r) => `${r.label}: ${r.crn}`).join('\n') : 'None of your courses open today.');
    });
    if (App.calendar.addDropStart) {
      allDay(`adddrop-${App.idx.term}`, App.calendar.addDropStart, App.calendar.addDropEnd || App.calendar.addDropStart, 'Add / drop', '');
    }
  }

  if (finals && App.exams) {
    for (const { exam, sec } of examPlan().rows) {
      const from = exam.start ?? 9 * 60;
      const to = exam.end ?? from + 120;
      lines.push('BEGIN:VEVENT', `UID:final-${sec.crn}-${App.idx.term}@sumods`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Europe/Istanbul:${icsStamp(exam.date, from)}`,
        `DTEND;TZID=Europe/Istanbul:${icsStamp(exam.date, to)}`,
        foldLine(`SUMMARY:${icsText(`${sec.course.code} final`)}`),
        ...(exam.place ? [foldLine(`LOCATION:${icsText(exam.place)}`)] : []),
        foldLine(`DESCRIPTION:${icsText(`${sec.course.title}\nCRN ${sec.crn}`)}`),
        'END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** Store-only zip, because the artifact host won't hand out a bare .ics. */
function zipOne(name, text) {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const nameBytes = new TextEncoder().encode(name);
  let table = zipOne.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    zipOne.table = table;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const head = new Uint8Array(30 + nameBytes.length);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(12, 0x2821, true);
  hv.setUint32(14, crc, true); hv.setUint32(18, data.length, true); hv.setUint32(22, data.length, true);
  hv.setUint16(26, nameBytes.length, true);
  head.set(nameBytes, 30);
  const dir = new Uint8Array(46 + nameBytes.length);
  const dv = new DataView(dir.buffer);
  dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(14, 0x2821, true);
  dv.setUint32(16, crc, true); dv.setUint32(20, data.length, true); dv.setUint32(24, data.length, true);
  dv.setUint16(28, nameBytes.length, true);
  dir.set(nameBytes, 46);
  const tail = new Uint8Array(22);
  const ev = new DataView(tail.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, dir.length, true); ev.setUint32(16, head.length + data.length, true);
  const out = new Uint8Array(head.length + data.length + dir.length + tail.length);
  out.set(head, 0); out.set(data, head.length); out.set(dir, head.length + data.length);
  out.set(tail, head.length + data.length + dir.length);
  return out;
}

const MIME = { ics: 'text/calendar;charset=utf-8', svg: 'image/svg+xml;charset=utf-8', png: 'image/png' };

async function saveFile(name, data) {
  const ext = name.split('.').pop();
  if (window.claude && typeof window.claude.use === 'function') {
    try {
      const downloads = await window.claude.use('downloads');
      if (downloads) {
        const zipped = ext === 'ics';   // .ics isn't in the host's allowlist, so a calendar travels zipped
        await downloads.save({ filename: zipped ? `${name.replace(/\.ics$/, '')}.zip` : name, data: zipped ? zipOne(name, data) : data });
        return 'saved';
      }
    } catch (err) {
      if (err && err.code === 'declined') return 'declined';
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'saved';
  } catch {
    return 'failed';
  }
}

function openExportDialog() {
  const cal = App.calendar || {};
  const schedule = (App.raw[store.term] || {}).dates || {};
  const start = cal.classesStart || schedule.start || '';
  const end = cal.classesEnd || schedule.end || '';
  const finals = App.exams ? examPlan().rows.length : 0;
  $('#export-body').innerHTML = `
    <p>One repeating event per class in Europe/Istanbul time. Import the file into Google Calendar,
       Apple Calendar or Outlook.</p>
    <label class="opt"><input type="checkbox" id="exp-classes" checked><span>Weekly classes and your own events</span></label>
    ${cal.registrationDays ? `<label class="opt"><input type="checkbox" id="exp-reminders" checked>
      <span>Registration day reminders at 09:00 — ${cal.registrationDays.map((d) => esc(shortDate(d))).join(', ')}${cal.addDropStart ? ', plus add/drop' : ''} — each listing the CRNs due that day</span></label>` : ''}
    <label class="opt"><input type="checkbox" id="exp-finals" ${finals ? 'checked' : 'disabled'}>
      <span>Final exams${finals ? ` (${finals})` : ' — no exam data for this term yet'}</span></label>
    <div class="date-row">
      <label>Classes start<input type="date" id="exp-start" value="${esc(start)}"></label>
      <label>Classes end<input type="date" id="exp-end" value="${esc(end)}"></label>
    </div>
    ${cal.examsStart ? `<p class="cat-sub">Finals run ${esc(fmtDate(cal.examsStart))} to ${esc(fmtDate(cal.examsEnd))}.</p>` : ''}
    ${cal.classesStart ? `<p class="cat-sub">Dates from the academic calendar${(cal.holidays || []).length
      ? `; ${cal.holidays.length} day${cal.holidays.length === 1 ? '' : 's'} off are skipped` : ''}.</p>`
      : '<p class="cat-sub">No academic calendar stored for this term — set the two dates yourself.</p>'}`;
  $('#dlg-export').showModal();
}

/* ------------------------------------------------------------ image export */

/** The timetable drawn as an SVG — shareable, and the source for the PNG export. */
function timetableSVG() {
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
  const blocks = planBlocks();
  if (!blocks.length) return null;
  const [startMin, endMin] = axisRange(blocks);
  const span = endMin - startMin;
  const days = [0, 1, 2, 3, 4];
  if (blocks.some((b) => b.day === 5)) days.push(5);
  const pad = 26, labelW = 52, headH = 74, hourW = 104, laneH = 62;
  const byDay = new Map(days.map((d) => [d, []]));
  blocks.forEach((b) => { if (byDay.has(b.day)) byDay.get(b.day).push(b); });
  const rows = days.map((day) => {
    const items = laneLayout(byDay.get(day), false);
    return { day, items, lanes: Math.max(1, items.reduce((n, x) => Math.max(n, x.lane + 1), 0)) };
  });
  const gridW = (span / 60) * hourW;
  const width = pad * 2 + labelW + gridW;
  const height = headH + rows.reduce((h, r) => h + r.lanes * laneH, 0) + pad + 34;
  const ink = token('--ink', '#13213c'), ink3 = token('--ink-3', '#7b869d');
  const rule = token('--rule', '#dde3ec'), surface = token('--surface', '#ffffff'), paper = token('--paper', '#f2f5f9');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Instrument Sans, system-ui, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${paper}"/>`,
    `<text x="${pad}" y="${pad + 14}" font-size="18" font-weight="700" fill="${ink}">SUMods — ${esc(App.idx.name)}</text>`];
  for (let t = startMin; t <= endMin; t += 60) {
    const x = pad + labelW + ((t - startMin) / span) * gridW;
    out.push(`<text x="${x}" y="${headH - 12}" font-size="12" fill="${ink3}" text-anchor="middle">${hhmm(t)}</text>`);
    out.push(`<line x1="${x}" y1="${headH}" x2="${x}" y2="${height - pad - 24}" stroke="${rule}"/>`);
  }
  let y = headH;
  for (const row of rows) {
    const h = row.lanes * laneH;
    out.push(`<rect x="${pad + labelW}" y="${y}" width="${gridW}" height="${h}" fill="${surface}" stroke="${rule}"/>`);
    out.push(`<text x="${pad + labelW - 10}" y="${y + 20}" font-size="13" font-weight="600" fill="${ink}" text-anchor="end">${DAYS[row.day]}</text>`);
    for (const { block: b, lane } of row.items) {
      const x = pad + labelW + ((b.start - startMin) / span) * gridW;
      const w = ((b.end - b.start) / span) * gridW;
      const top = y + lane * laneH + 3;
      const fg = token(`--c${b.color}-ink`, '#123c97');
      out.push(`<rect x="${x + 2}" y="${top}" width="${Math.max(6, w - 4)}" height="${laneH - 6}" rx="7" fill="${token(`--c${b.color}-bg`, '#d9e6ff')}" stroke="${token(`--c${b.color}-edge`, '#a8c4f7')}"/>`);
      out.push(`<text x="${x + 10}" y="${top + 18}" font-size="13" font-weight="700" fill="${fg}">${esc(b.code)}${b.group && b.group !== '0' ? ` ${esc(b.group)}` : ''}</text>`);
      if (b.where && w > 90) out.push(`<text x="${x + 10}" y="${top + 34}" font-size="11.5" fill="${fg}" opacity=".8">${esc(b.where)}</text>`);
    }
    y += h;
  }
  out.push(`<text x="${pad}" y="${height - pad + 6}" font-size="11" fill="${ink3}">${esc(crnRows().map((r) => r.crn).join('  '))}</text>`);
  out.push('</svg>');
  return out.join('');
}

async function saveTimetableImage() {
  const svg = timetableSVG();
  if (!svg) { toast('Add a course first'); return; }
  const name = `sumods-${store.term}`;
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width * 2;
    canvas.height = image.height * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('no image');
    const result = await saveFile(`${name}.png`, new Uint8Array(await blob.arrayBuffer()));
    toast(result === 'saved' ? 'Timetable saved as an image' : result === 'declined' ? 'Download cancelled' : 'Could not save the image here');
  } catch {
    const result = await saveFile(`${name}.svg`, svg);
    toast(result === 'saved' ? 'Timetable saved as an SVG' : 'Could not save the image here');
  }
}

/* --------------------------------------------------------------- chrome */

function toast(message, { action, onAction, timeout = 6000 } = {}) {
  const host = $('#toast-host');
  host.innerHTML = '';
  const node = document.createElement('div');
  node.className = 'toast';
  node.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action;
    btn.addEventListener('click', () => { host.innerHTML = ''; onAction?.(); });
    node.appendChild(btn);
  }
  host.appendChild(node);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { if (host.firstChild === node) host.innerHTML = ''; }, timeout);
}

function applyTheme() {
  const mode = store.prefs.theme;
  document.documentElement.setAttribute('data-theme', mode === 'auto' ? '' : mode);
  const btn = $('#theme-btn');
  if (btn) {
    btn.innerHTML = icon(mode === 'dark' ? 'moon' : 'sun');
    btn.title = `Theme: ${mode}`;
    btn.setAttribute('aria-label', `Theme: ${mode}. Change`);
  }
}

function setView(view) {
  store.view = view;
  save();
  if (view === 'plan') ensureUnion().then(() => { if (store.view === 'plan') renderPlanner(); });
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $$('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  render();
}

function validateSelections() {
  const t = tt();
  let repicked = 0, dropped = [];
  for (const code of [...t.order]) {
    const course = App.idx.byCode.get(code);
    if (!course) {
      dropped.push(code);
      delete t.courses[code];
      t.order = t.order.filter((c) => c !== code);
      continue;
    }
    const e = t.courses[code];
    for (const comp of course.components) {
      const sec = App.idx.byCrn.get(e.sel[comp.type]);
      if (sec && sec.component.type === comp.type && sec.course.code === code) continue;
      const lecture = App.idx.byCrn.get(e.sel['']);
      const options = compatibleSections(course, comp, lecture);
      if (options[0]) { e.sel[comp.type] = options[0].crn; repicked += 1; }
    }
    for (const type of Object.keys(e.sel)) {
      if (!course.components.some((c) => c.type === type)) delete e.sel[type];
    }
  }
  if (dropped.length || repicked) {
    save();
    toast(`${dropped.length ? `${dropped.join(', ')} is no longer offered. ` : ''}${repicked ? `${repicked} section${repicked === 1 ? '' : 's'} re-picked after a data update.` : ''}`.trim());
  }
}

async function setTerm(code, { silent = false } = {}) {
  store.term = code;
  App.swap = null;
  App.room = null;
  try {
    App.idx = indexTerm(await loadTerm(code));
  } catch (err) {
    showDataError(err);
    return;
  }
  App.info = null;
  App.calendar = null;
  App.exams = null;
  App.regdays = null;
  loadInfo(code).then((info) => {
    if (store.term !== code) return;
    App.info = info;
    if (info) render();
  });
  loadSide(code, 'calendar').then((cal) => {
    if (store.term === code) App.calendar = cal;
  });
  App.seats = null;
  App.liveSeats = {};
  loadSide(code, 'seats').then((raw) => {
    if (store.term !== code || !raw) return;
    App.seats = raw;
    render();
  });
  loadSide(code, 'regdays').then((raw) => {
    if (store.term !== code || !raw) return;
    App.regdays = raw;
    render();
  });
  loadSide(code, 'exams').then((raw) => {
    if (store.term !== code || !raw) return;
    App.exams = indexExams(raw);
    render();
  });
  $('#term-select').value = code;
  validateSelections();
  buildSubjectFilter();
  save();
  if (!silent) render();
}

function buildSubjectFilter() {
  const sel = $('#cat-subject');
  const subjects = [...App.idx.subjects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  sel.innerHTML = `<option value="all">All subjects</option>` +
    subjects.map(([s, n]) => `<option value="${esc(s)}">${esc(s)} (${n})</option>`).join('');
}

function showDataError(err) {
  $('#grid').innerHTML = `<div style="padding:26px 14px;text-align:center">
    <p style="font-weight:600;margin:0 0 6px">Course data didn't load</p>
    <p class="cat-sub" style="margin:0">Run <code>python scraper/scrape.py</code> to build <code>data/terms.json</code>, then reload.</p>
    <p class="cat-sub">${esc(err && err.message ? err.message : String(err))}</p></div>`;
}

function render() {
  if (!App.idx) return;
  $('#term-note').textContent = `Updated ${new Date(App.idx.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('#source-note').textContent = App.idx.source || '';
  $('#preview-banner').hidden = !App.preview;
  if (store.view === 'plan') renderPlanner();
  if (store.view === 'today') renderToday();
  if (store.view === 'timetable') renderTimetable();
  if (store.view === 'courses') renderCatalog();
  if (store.view === 'rooms') renderRooms();
  $$('.chip-btn[data-orientation]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.orientation === orientation())));
}

/* ------------------------------------------------------------ share links */

function parseHash() {
  const share = /^#share\/(\d{6})\/([\d.]+)$/.exec(location.hash || '');
  if (share) return { kind: 'share', term: share[1], crns: share[2].split('.').filter(Boolean) };
  const course = /^#course\/([A-Za-z]+\d+[A-Za-z]*)(?:\/(\d{6}))?$/.exec(location.hash || '');
  if (course) return { kind: 'course', slug: course[1].toUpperCase(), term: course[2] };
  return null;
}

function openCourseBySlug(slug) {
  const course = App.idx.courses.find((c) => c.code.replace(/\s+/g, '').toUpperCase() === slug);
  if (!course) { toast(`${slug} isn't offered in ${App.idx.name}`); return; }
  openCourseDialog(course.code);
}

function startPreview(hash) {
  App.preview = { term: hash.term, tt: { order: [], courses: {} } };
  const saved = App.preview.tt;
  for (const crn of hash.crns) {
    const sec = App.idx.byCrn.get(crn);
    if (!sec) continue;
    const code = sec.course.code;
    if (!saved.courses[code]) {
      saved.courses[code] = { color: saved.order.length % COLORS, hidden: false, sel: {} };
      saved.order.push(code);
    }
    saved.courses[code].sel[sec.component.type] = crn;
  }
}

function endPreview(keep) {
  const preview = App.preview;
  App.preview = null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
  if (keep && preview) {
    store.tts[preview.term] = preview.tt;
    save();
    toast('Shared timetable saved');
  }
  render();
}

function shareLink() {
  const crns = crnRows().map((r) => r.crn);
  if (!crns.length) return '';
  return `${location.origin}${location.pathname}#share/${store.term}/${crns.join('.')}`;
}

/* ------------------------------------------------------------------ events */

function bindEvents() {
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $('#term-select').addEventListener('change', (e) => setTerm(e.target.value));

  $('#theme-btn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    store.prefs.theme = order[(order.indexOf(store.prefs.theme) + 1) % order.length];
    applyTheme();
    save();
    toast(`Theme: ${store.prefs.theme}`, { timeout: 1600 });
  });

  // search
  const search = $('#search');
  search.addEventListener('input', () => { App.resultIndex = 0; renderSearchResults(); });
  search.addEventListener('focus', () => { if (search.value.trim()) renderSearchResults(); });
  search.addEventListener('keydown', (e) => {
    const n = (App.results || []).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      App.resultIndex = ((App.resultIndex || 0) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderSearchResults();
    } else if (e.key === 'Enter') {
      const c = (App.results || [])[App.resultIndex || 0];
      if (c) pickResult(c.code);
    } else if (e.key === 'Escape') {
      search.value = '';
      closeSearch();
    }
  });
  $('#search-clear').addEventListener('click', () => { search.value = ''; closeSearch(); search.focus(); });
  $('#search-results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-code]');
    if (btn) pickResult(btn.dataset.code);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeSearch();
  });

  // timetable grid
  $('#grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-block]');
    if (!btn) return;
    const b = App.blockData.get(btn.dataset.block);
    if (!b) return;
    if (b.kind === 'ghost') {
      const sections = b.sections;
      App.swap = null;
      selectSection(sections[0].course.code, sections[0].component.type, sections[0].crn);
      if (sections.length > 1) toast(`${sections[0].component.code} ${sections[0].group} — ${sections.length} sections share this slot, pick another below`, { timeout: 5000 });
      return;
    }
    if (readonlyMode()) return;
    if (b.kind === 'custom') { openEventDialog(b.custom.id); return; }
    if (App.swap && App.swap.code === b.courseCode && App.swap.type === b.type) { App.swap = null; render(); return; }
    if (!swapPatterns(b.courseCode, b.type).length) {
      toast(`${b.code} has no other time slot`, { timeout: 2600 });
      return;
    }
    App.swap = { code: b.courseCode, type: b.type };
    store.prefs.hintDone = true;
    save();
    render();
  });
  $('#swapbar').addEventListener('click', (e) => {
    if (e.target.id === 'swap-cancel') { App.swap = null; render(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && App.swap) { App.swap = null; render(); }
  });

  // course list
  $('#course-list').addEventListener('click', (e) => {
    const host = e.target.closest('.course');
    if (!host) return;
    const code = host.dataset.code;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'info') openCourseDialog(code);
    else if (act === 'remove') removeCourse(code);
    else if (act === 'hide') { entry(code).hidden = !entry(code).hidden; save(); render(); }
    else if (act === 'palette') { entry(code).paletteOpen = !entry(code).paletteOpen; render(); }
    else if (act === 'color') {
      entry(code).color = Number(e.target.closest('[data-color]').dataset.color);
      entry(code).paletteOpen = false;
      save(); render();
    }
  });
  $('#course-list').addEventListener('change', (e) => {
    const sel = e.target.closest('.sec-select');
    if (sel) { store.prefs.hintDone = true; selectSection(sel.dataset.code, sel.dataset.type, sel.value); }
  });

  // actions
  $('#actions').addEventListener('click', async (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'act-crn') openCrnDialog();
    if (id === 'act-arrange') $('#dlg-arrange').showModal();
    if (id === 'act-export') openExportDialog();
    if (id === 'act-image') saveTimetableImage();
    if (id === 'act-event') openEventDialog(null);
    if (id === 'act-clear') {
      pushUndo('clear');
      store.tts[store.term] = { order: [], courses: {} };
      App.swap = null;
      save(); render();
      toast('Timetable cleared', { action: 'Undo', onAction: undo });
    }
    if (id === 'act-share') {
      const link = shareLink();
      toast(await copyText(link) ? 'Share link copied' : 'Could not copy — the link is in the CRN window');
    }
  });

  $('#grid').addEventListener('click', (e) => {
    if (e.target.id === 'sample-btn') {
      ['MATH 101', 'NS 101', 'SPS 101', 'HIST 191', 'AL 102', 'TLL 101']
        .filter((c) => App.idx.byCode.has(c)).forEach((c) => {
          if (!entry(c)) {
            const t = tt();
            t.courses[c] = { color: nextColor(), hidden: false, sel: {} };
            t.order.push(c);
            t.courses[c].sel = bestCombo(App.idx.byCode.get(c)).sel;
          }
        });
      save(); render();
      toast('Sample timetable loaded', { action: 'Undo', onAction: undo });
    }
  });

  $$('.chip-btn[data-orientation]').forEach((b) => b.addEventListener('click', () => {
    store.prefs.orientation = b.dataset.orientation;
    save(); render();
  }));

  // dialogs
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#dlg-crn').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-crn]');
    if (row) {
      const ok = await copyText(row.dataset.crn);
      row.querySelector('.crn-copy').textContent = ok ? 'copied' : 'select it manually';
      return;
    }
    if (e.target.id === 'crn-copy-all') {
      const text = crnRows().map((r) => `${r.label}: ${r.crn}`).join('\n');
      toast(await copyText(text) ? 'CRN list copied' : 'Could not copy — select the list manually');
    }
    if (e.target.id === 'crn-load') {
      loadCrns($('#crn-paste').value);
      $('#dlg-crn').close();
    }
  });

  $('#dlg-arrange').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-day]');
    if (chip) chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    if (e.target.id === 'arrange-run') runOptimiser();
    const option = e.target.closest('[data-option]');
    if (option) {
      const result = (App.options || [])[Number(option.dataset.option)];
      if (result) {
        applyOption(result, `Option ${Number(option.dataset.option) + 1} applied`);
        $('#dlg-arrange').close();
      }
    }
  });

  $('#dlg-export').addEventListener('click', async (e) => {
    if (e.target.id !== 'export-run') return;
    const start = $('#exp-start').value;
    const end = $('#exp-end').value;
    if (!start || !end || start >= end) { toast('Set a term start and end date first'); return; }
    const text = buildICS({ start, end, classes: $('#exp-classes').checked, finals: $('#exp-finals').checked,
      reminders: $('#exp-reminders') ? $('#exp-reminders').checked : false });
    $('#dlg-export').close();
    const result = await saveFile(`sumods-${store.term}.ics`, text);
    toast(result === 'saved' ? 'Calendar file ready — import it into your calendar app'
      : result === 'declined' ? 'Download cancelled'
      : 'Could not save the file here — try the deployed site');
  });

  // preview banner
  $('#preview-banner').addEventListener('click', (e) => {
    if (e.target.id === 'preview-keep') endPreview(true);
    if (e.target.id === 'preview-drop') endPreview(false);
  });

  $('#dlg-course').addEventListener('click', (e) => {
    if (e.target.id === 'seats-refresh') {
      const code = $('#course-add').dataset.code;
      const course = App.idx.byCode.get(code);
      e.target.textContent = 'Refreshing…';
      refreshSeats(course.components.flatMap((comp) => comp.sections.map((s) => s.crn))).then((ok) => {
        openCourseDialog(code);
        toast(ok ? 'Seats refreshed from BannerWeb' : 'Could not reach the seats service');
      });
      return;
    }
    const req = e.target.closest('.req, .pg-node');
    if (req && App.idx.byCode.has(req.dataset.course)) { openCourseDialog(req.dataset.course); return; }
    if (req && req.classList.contains('pg-node')) { toast(`${req.dataset.course} isn't offered in ${App.idx.name}`); return; }
    if (e.target.id === 'course-add') {
      const code = e.target.dataset.code;
      if (entry(code)) removeCourse(code); else addCourse(code);
      $('#dlg-course').close();
    }
  });

  // catalog
  $('#cat-search').addEventListener('input', () => { App.catalogLimit = 80; renderCatalog(); });
  $('#cat-subject').addEventListener('change', () => { App.catalogLimit = 80; renderCatalog(); });
  $$('#cat-level button').forEach((b) => b.addEventListener('click', () => {
    App.catLevel = b.dataset.level;
    $$('#cat-level button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderCatalog();
  }));
  $('#catalog').addEventListener('click', (e) => {
    if (e.target.id === 'cat-more') { App.catalogLimit += 200; renderCatalog(); return; }
    const item = e.target.closest('.cat-item');
    if (!item) return;
    const code = item.dataset.code;
    if (e.target.closest('[data-act="add"]')) {
      if (entry(code)) removeCourse(code); else addCourse(code);
      return;
    }
    const body = item.querySelector('.cat-body');
    if (!item.classList.contains('open')) body.innerHTML = courseDetailHTML(App.idx.byCode.get(code));
    item.classList.toggle('open');
  });

  $('#regdays').addEventListener('change', (e) => {
    if (e.target.id !== 'reg-program' && e.target.id !== 'reg-major2') return;
    const first = $('#reg-program').value;
    const second = $('#reg-major2').value;
    store.prefs.programs = [first, second].filter(Boolean);
    save();
    render();
  });
  $('#regdays').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-crn]');
    if (!chip) return;
    const ok = await copyText(chip.dataset.crn);
    toast(ok ? `${chip.dataset.crn} copied` : 'Could not copy — select it manually', { timeout: 2200 });
  });

  $('#course-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-event]');
    if (row) openEventDialog(row.dataset.event);
  });
  $('#dlg-event').addEventListener('click', (e) => {
    const swatch = e.target.closest('#event-colors [data-color]');
    if (swatch) {
      $$('#event-colors [data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b === swatch)));
      return;
    }
    if (e.target.id === 'event-save' && saveEvent()) $('#dlg-event').close();
    if (e.target.id === 'event-delete') {
      pushUndo('event');
      tt().custom = customEvents().filter((x) => x.id !== App.editingEvent);
      save();
      render();
      $('#dlg-event').close();
      toast('Event removed', { action: 'Undo', onAction: undo });
    }
  });

  // planner
  $('#plan-body').addEventListener('click', (e) => {
    const card = e.target.closest('[data-term]');
    const id = card && card.dataset.term;
    const addButton = e.target.closest('[data-add]');
    if (addButton) { App.addingTo = addButton.dataset.add; renderPlanner(); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) { addToTerm(App.addingTo || id, pick.dataset.pick); return; }
    const remove = e.target.closest('[data-remove]');
    if (remove && id) { removeFromTerm(id, remove.dataset.remove); return; }
    const dropTerm = e.target.closest('[data-drop-term]');
    if (dropTerm) {
      const plan = planState();
      const before = JSON.stringify(plan.terms);
      plan.terms = plan.terms.filter((t) => t.id !== dropTerm.dataset.dropTerm);
      save();
      renderPlanner();
      toast(`${termLabel(dropTerm.dataset.dropTerm)} removed`, {
        action: 'Undo', onAction: () => { planState().terms = JSON.parse(before); save(); renderPlanner(); },
      });
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      if (App.idx.byCode.has(open.dataset.open)) openCourseDialog(open.dataset.open);
      else toast(`${open.dataset.open} isn't offered in ${App.idx.name}`);
      return;
    }
    if (e.target.id === 'plan-add-term') { addTerm($('#new-term').value); return; }
    if (e.target.id === 'plan-import') { openImportDialog(); return; }
    if (e.target.id === 'plan-fill') { fillSuggested(); return; }
    if (e.target.id === 'plan-clear') {
      const before = JSON.stringify(planState().terms);
      planState().terms = [];
      save();
      renderPlanner();
      toast('Plan cleared', { action: 'Undo', onAction: () => { planState().terms = JSON.parse(before); save(); renderPlanner(); } });
    }
  });
  $('#plan-body').addEventListener('change', (e) => {
    if (e.target.id === 'plan-program') {
      planState().program = e.target.value || null;
      planState().entry = planState().terms[0] ? planState().terms[0].id : null;
      save();
      refreshRequirements();
    }
    if (e.target.id === 'plan-entry') { planState().entry = e.target.value; save(); refreshRequirements(); }
    const grade = e.target.closest('[data-grade]');
    if (grade) {
      const id = grade.closest('[data-term]').dataset.term;
      setGrade(id, grade.dataset.grade, grade.value);
    }
  });

  $('#dlg-import').addEventListener('change', (e) => {
    if (e.target.id === 'import-file' && e.target.files[0]) handleTranscriptFile(e.target.files[0]);
  });
  $('#dlg-import').addEventListener('click', (e) => {
    if (e.target.id === 'import-apply') { applyTranscript(); $('#dlg-import').close(); }
  });

  // rooms
  ['#room-search', '#room-day', '#room-time'].forEach((sel) =>
    $(sel).addEventListener('input', () => renderRooms()));
  $('#room-free').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-room]');
    if (!btn) return;
    App.room = App.room === btn.dataset.room ? null : btn.dataset.room;
    renderRooms();
    if (App.room) $('#room-grid-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (store.prefs.orientation === 'auto') render(); }, 180);
  });
}

function fillRoomControls() {
  const now = istanbulNow();
  $('#room-day').innerHTML = DAYS.slice(0, 6).map((d, i) =>
    `<option value="${i}"${i === Math.min(now.day, 5) ? ' selected' : ''}>${d}</option>`).join('');
  const slots = [];
  for (let t = DAY_START; t <= 21 * 60 + 40; t += 60) slots.push(t);
  const nearest = slots.reduce((a, b) => (Math.abs(b - now.min) < Math.abs(a - now.min) ? b : a), slots[0]);
  $('#room-time').innerHTML = slots.map((t) => `<option value="${t}"${t === nearest ? ' selected' : ''}>${hhmm(t)}</option>`).join('');
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  loadStore();
  applyTheme();
  bindEvents();
  try {
    App.index = await loadIndex();
  } catch (err) {
    showDataError(err);
    return;
  }
  loadPrograms().then((programs) => {
    App.programs = programs;
    refreshRequirements();
  });
  const terms = App.index.terms || [];
  if (!terms.length) { showDataError(new Error('terms.json lists no terms')); return; }
  const years = new Map();
  terms.forEach((t) => {
    const year = `${t.code.slice(0, 4)}-${Number(t.code.slice(0, 4)) + 1}`;
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(t);
  });
  $('#term-select').innerHTML = [...years.entries()].map(([year, list]) =>
    `<optgroup label="${esc(year)}">${list.map((t) => `<option value="${esc(t.code)}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('');
  fillRoomControls();

  const hash = parseHash();
  let term = hash?.term || store.term;
  if (!terms.some((t) => t.code === term)) term = defaultTermCode(terms);
  await setTerm(term, { silent: true });
  if (!App.idx) return;
  if (hash?.kind === 'share') startPreview(hash);
  setView(hash ? 'timetable' : (store.view || 'timetable'));
  if (hash?.kind === 'course') openCourseBySlug(hash.slug);
}

setInterval(() => { if (store.view === 'today' && App.idx) renderToday(); }, 60000);

document.addEventListener('DOMContentLoaded', boot);
