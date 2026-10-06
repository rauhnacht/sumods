/* Behaviour added with the double-major / plan / instructors round: self prerequisites, "Opens up" for
 * courses not offered this term, red credits, primary instructors, timetable -> plan sync, the double-major and
 * registration pickers. Sets up its own programme files (and removes them again), then rebuilds dist/. */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const progDir = path.join(root, 'data', 'programs');
const launchOptions = () => (process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

function programme(name, total, core, dm) {
  return { name, entries: { 202601: { groups: [
    { name: 'Required Courses', kind: 'required', courses: ['EE 201'] },
    { name: 'Core Electives', kind: 'core', credits: dm ? 9 : 25, courses: dm ? [] : core },
    { name: 'Area Electives', kind: 'area', credits: 9, courses: dm ? [] : ['CS 412'] },
    { name: 'Free Electives', kind: 'free', credits: 12, any: true, courses: dm ? [] : ['HUM 207'] }], totalCredits: total } } };
}

function minor(name, required, core, area) {
  return { name, entries: { 202601: { groups: [
    { name: 'Required Courses', kind: 'required', credits: 6, minCourses: 2, courses: required },
    { name: 'Core Electives', kind: 'core', credits: 6, minCourses: 2, courses: core },
    { name: 'Area Electives', kind: 'area', credits: 6, minCourses: 2, courses: area }], totalCredits: 18 } } };
}

const FILES = {
  BSEE: programme('Electronics Engineering', 129, ['EE 311', 'EE 313'], false),
  'BSEE-DM': programme('Electronics Engineering (Double Major)', 70, [], true),
  BSMAT: programme('Materials Science and Nano Engineering', 125, ['MAT 301', 'MAT 306'], false),
  'BSMAT-DM': programme('Materials Science and Nano Engineering (Double Major)', 65, [], true),
  BSCS: programme('Computer Science and Engineering', 125, ['CS 301'], false),
  BSMS: programme('Industrial Engineering', 126, ['IE 301', 'IE 305'], false),
  'BSIE-DM': programme('Industrial Engineering (Double Major)', 60, [], true),   // Industrial's double major is BSIE-DM, not BSMS-DM
  'PHIL-MINOR': minor('Philosophy (Minor)', ['HUM 207', 'PHIL 202'], ['PHIL 300', 'PHIL 301'], ['PHIL 322']),
  'MATH-MINOR': minor('Mathematics (Minor)', ['MATH 201', 'MATH 203'], ['MATH 306'], ['MATH 204']),
};

const build = () => execSync('python3 build_standalone.py', { cwd: root, stdio: 'ignore' });

function setup() {
  fs.mkdirSync(progDir, { recursive: true });
  const indexPath = path.join(progDir, 'index.json');
  const backup = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : null;
  Object.entries(FILES).forEach(([code, f]) => fs.writeFileSync(path.join(progDir, `${code}.json`), JSON.stringify({ ...f, program: code })));
  fs.writeFileSync(indexPath, JSON.stringify({ schema: 1, programs: Object.entries(FILES).map(([code, f]) => ({ code, name: f.name, entries: ['202601'] })) }));
  build();
  return () => {
    Object.keys(FILES).forEach((code) => fs.rmSync(path.join(progDir, `${code}.json`), { force: true }));
    if (backup === null) fs.rmSync(indexPath, { force: true }); else fs.writeFileSync(indexPath, backup);
    build();
  };
}

async function featuresTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  const add = async (c) => { await p.fill('#search', c); await p.waitForTimeout(140); const h = p.locator(`#search-results [data-code="${c}"]`).first(); if (await h.count()) { await h.click(); await p.waitForTimeout(150); } };

  // ---- self prerequisites (SPS 303 vs SPS 303D) are ignored
  const own = await p.evaluate(() => { const realInfo = App.info; App.info = { courses: {} }; App.infoAll = { courses: { 'SPS 303': { prereqCodes: [['SPS 303'], ['SPS 303D'], ['MATH 101']] }, 'EE 202': { prereqCodes: [['ENS 203']] }, 'ENS 203': { prereqCodes: [] } } }; const out = { groups: requirementGroups('SPS 303'), opens: unlockedBy('ENS 203') }; App.info = realInfo; return out; });   // the scraped current-term info would otherwise win over these fixtures
  check('a course is never its own prerequisite', JSON.stringify(own.groups) === '[["MATH 101"]]', JSON.stringify(own.groups));
  check('"Opens up" includes courses not offered this term (ENS 203 → EE 202)', own.opens.includes('EE 202'), JSON.stringify(own.opens));

  // ---- opens-up list shows it and a catalog-only dialog opens
  await p.evaluate(() => ensureUnion());
  await p.evaluate(() => { openCourseDialog('ENS 203'); });
  await p.waitForTimeout(300);
  const html = await p.locator('#course-body').innerHTML().catch(() => '');
  const dimmed = await p.evaluate(() => [...document.querySelectorAll('#course-body [data-course="EE 202"]')].map((n) => n.getAttribute('class')));
  check('ENS 203 dialog lists EE 202 under Opens up (dimmed: not in this term)', dimmed.length >= 1 && dimmed.every((c) => /offterm|req-off/.test(c)), JSON.stringify(dimmed));
  await p.locator('#course-body [data-course="EE 202"]').first().click(); await p.waitForTimeout(300);
  const title = await p.locator('#course-dlg-title').textContent();
  check('clicking a course that is not offered still opens its catalog entry', /EE 202/.test(title) && /Not offered in/.test(await p.locator('#course-body').textContent()), title);
  check('…and cannot be added to this term', await p.locator('#course-add').isDisabled());
  await p.keyboard.press('Escape');

  // ---- credits turn red above 20
  for (const c of ['CS 201', 'EE 311', 'MATH 201', 'HUM 207', 'ENS 491', 'DSA 201', 'EE 303']) await add(c);
  await p.evaluate(() => { App.idx.byCode.forEach((c) => { c.credits = 4; }); render(); });
  const read = async () => ({ total: await p.evaluate(() => tt().order.length * 4), red: await p.locator('.stat.over').count(), text: (await p.locator('.stat', { hasText: 'SU credits' }).first().textContent()).trim() });
  const high = await read();
  check('SU credits go red once over the 20-credit maximum', high.total > 20 && high.red === 1, `${high.text}, red pills: ${high.red}`);
  await p.evaluate(() => { ['DSA 201', 'EE 303', 'ENS 491'].forEach((c) => removeCourse(c)); });
  await p.waitForTimeout(200);
  const low = await read();
  check('…and back to normal at or under 20', low.total <= 20 && low.red === 0, `${low.text}, red pills: ${low.red}`);
  for (const c of ['DSA 201', 'EE 303', 'ENS 491']) await add(c);
  await p.evaluate(() => { store.prefs.showInstructor = true; render(); });

  // ---- instructors: full name, only the primary
  const who = await p.evaluate(() => { const s = App.idx.byCode.get('CS 201').lecture.sections[0]; return { opt: sectionOptionLabel(s), names: s.people }; });
  check('section picker shows the full instructor name', /Saima Gül/.test(who.opt), who.opt);
  const blockText = (await p.locator('#grid .blk', { hasText: 'CS 201' }).first().textContent()).replace(/\s+/g, ' ');
  check('class blocks show the full name too', /Saima Gül/.test(blockText), blockText);
  const multi = await p.evaluate(() => { const s = { people: ['Saima Gül', 'Ali Veli', 'Ayşe Kaya'] }; const e = { sel: { '': 'x' } }; App.idx.byCrn.set('x', s); return mainInstructors({}, e); });
  check('with several instructors only the first (primary) is shown', multi === 'Saima Gül', multi);

  // ---- timetable feeds the plan
  const plan1 = await p.evaluate(() => planState().terms.find((t) => t.id === store.term)?.courses.map((c) => c.code).sort());
  check('timetable courses appear in the plan for that term', plan1 && ['CS 201', 'EE 311', 'MATH 201'].every((c) => plan1.includes(c)), JSON.stringify(plan1));
  await p.evaluate(() => removeCourse('CS 201')); await p.waitForTimeout(200);
  check('removing from the timetable removes it from the plan', !(await p.evaluate(() => planState().terms.find((t) => t.id === store.term).courses.some((c) => c.code === 'CS 201'))));
  await p.evaluate(() => { planState().terms.find((t) => t.id === store.term).courses = planState().terms.find((t) => t.id === store.term).courses.filter((c) => c.code !== 'EE 311'); save(); render(); });
  check('deleting it from the plan sticks while it stays in the timetable', !(await p.evaluate(() => planState().terms.find((t) => t.id === store.term).courses.some((c) => c.code === 'EE 311'))));
  await p.evaluate(() => { setGrade(store.term, 'MATH 201', 'A'); removeCourse('MATH 201'); });
  check('a course with a grade stays in the plan when the timetable drops it', await p.evaluate(() => planState().terms.find((t) => t.id === store.term).courses.some((c) => c.code === 'MATH 201')));

  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

async function doubleMajorTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  await p.locator('.tabs [data-view="plan"]').click(); await p.waitForTimeout(400);
  const opts = async (sel) => (await p.locator(`${sel} option`).evaluateAll((o) => o.map((x) => x.value))).filter(Boolean);

  check('main picker lists only normal programmes', JSON.stringify(await opts('#plan-program')) === '["BSEE","BSMAT","BSCS","BSMS"]', JSON.stringify(await opts('#plan-program')));
  check('no main programme -> no double-major picker and no "Add minor"', (await p.locator('#plan-program2').count()) === 0 && (await p.locator('#plan-minor-add').count()) === 0);
  await p.selectOption('#plan-program', 'BSCS'); await p.waitForTimeout(400);
  check('double-major picker lists only -DM programmes', JSON.stringify(await opts('#plan-program2')) === '["BSEE-DM","BSMAT-DM","BSIE-DM"]', JSON.stringify(await opts('#plan-program2')));
  await p.selectOption('#plan-program', 'BSEE'); await p.waitForTimeout(400);
  check('with BSEE as the main programme, BSEE-DM is not offered', JSON.stringify(await opts('#plan-program2')) === '["BSMAT-DM","BSIE-DM"]', JSON.stringify(await opts('#plan-program2')));
  await p.selectOption('#plan-program2', 'BSMAT-DM'); await p.waitForTimeout(500);
  check('…and BSMAT is no longer offered as a main programme', JSON.stringify(await opts('#plan-program')) === '["BSEE","BSCS","BSMS"]', JSON.stringify(await opts('#plan-program')));

  const dm = await p.evaluate(() => { const r = activePrograms().find((x) => x.code === 'BSMAT-DM'); return r.groups.filter((g) => ['core', 'area', 'free'].includes(g.kind)).map((g) => [g.kind, (g.courses || []).length, g.borrowed || null, g.credits || null]); });
  check("BSMAT-DM's core/area/free are BSMAT's own lists (credit targets stay the DM's)", JSON.stringify(dm) === '[["core",2,"BSMAT",9],["area",1,"BSMAT",9],["free",1,"BSMAT",12]]', JSON.stringify(dm));
  const text = (await p.locator('#plan-body').textContent()).replace(/\s+/g, ' ');
  check('the plan shows the double major with its own credit target', /Graduation needs 65 SU credits/.test(text));

  // choosing the main programme to clash with the double major
  await p.selectOption('#plan-program', 'BSCS'); await p.waitForTimeout(300);
  check('picking a different main programme keeps the double major', (await p.evaluate(() => planState().program2)) === 'BSMAT-DM');

  // ---- registration panel is tied to the plan
  await p.locator('.tabs [data-view="timetable"]').click(); await p.waitForTimeout(400);
  const reg = async (sel) => (await p.locator(`${sel} option`).evaluateAll((o) => o.map((x) => x.value))).filter(Boolean);
  const firstSel = await p.inputValue('#reg-program'), secondSel = await p.inputValue('#reg-major2');
  check('registration panel shows the programmes chosen in the Plan (CS + MAT)', firstSel === 'CS' && secondSel === 'MAT', `${firstSel} / ${secondSel}`);
  check('main list leaves out the double major (MAT)', !(await reg('#reg-program')).includes('MAT'));
  const second = await reg('#reg-major2');
  check('double-major list leaves out the main programme (CS) and "Undeclared"', !second.includes('CS') && !second.includes('Undeclared'), second.join(','));
  await p.selectOption('#reg-program', 'EE'); await p.waitForTimeout(400);
  check('choosing a main programme in the panel updates the Plan', (await p.evaluate(() => planState().program)) === 'BSEE');
  check('…and the double major is still there', (await p.evaluate(() => planState().program2)) === 'BSMAT-DM');
  await p.selectOption('#reg-major2', ''); await p.waitForTimeout(300);
  check('clearing the double major in the panel clears it in the Plan', (await p.evaluate(() => planState().program2)) === null);
  await p.selectOption('#reg-program', 'Undeclared'); await p.waitForTimeout(300);
  check('"Undeclared" works as a main programme (kept for registration only)', (await p.evaluate(() => [planState().program, planState().regPrimary])).join() === ',Undeclared');
  check('…and then is not offered as a double major', !(await reg('#reg-major2')).includes('Undeclared'));

  // an older plan that stored the plain code for the double major
  const migrated = await p.evaluate(async () => { const pl = planState(); pl.program = 'BSEE'; pl.regPrimary = null; pl.program2 = 'BSMAT'; await refreshRequirements(); return planState().program2; });
  check('an older plan with program2 = BSMAT becomes BSMAT-DM', migrated === 'BSMAT-DM', migrated);
  // ---- Industrial Engineering: BSMS, but its double major is BSIE-DM
  await p.locator('.tabs [data-view="plan"]').click(); await p.waitForTimeout(300);
  await p.selectOption('#plan-program', 'BSEE'); await p.waitForTimeout(300);
  await p.selectOption('#plan-program2', 'BSIE-DM'); await p.waitForTimeout(500);
  const ie = await p.evaluate(() => { const r = activePrograms().find((x) => x.code === 'BSIE-DM'); return r && r.groups.filter((g) => g.kind === 'core').map((g) => [(g.courses || []).length, g.borrowed || null]); });
  check("BSIE-DM takes BSMS's own lists, not a BSMS-DM that doesn't exist", JSON.stringify(ie) === '[[2,"BSMS"]]', JSON.stringify(ie));
  check('the main picker no longer offers BSMS while BSIE-DM is the double major', !(await opts('#plan-program')).includes('BSMS'));
  await p.locator('.tabs [data-view="timetable"]').click(); await p.waitForTimeout(300);
  check('registration panel shows the IE department for BSIE-DM', (await p.inputValue('#reg-major2')) === 'IE (MS)', await p.inputValue('#reg-major2'));
  await p.selectOption('#reg-major2', 'MAT'); await p.waitForTimeout(300);
  await p.selectOption('#reg-major2', 'IE (MS)'); await p.waitForTimeout(300);
  check('choosing IE as the double major in the panel gives BSIE-DM', (await p.evaluate(() => planState().program2)) === 'BSIE-DM', await p.evaluate(() => planState().program2));
  const migratedIE = await p.evaluate(async () => { planState().program2 = 'BSMS'; planState().program = 'BSEE'; await refreshRequirements(); return planState().program2; });
  check('an older plan with program2 = BSMS becomes BSIE-DM', migratedIE === 'BSIE-DM', migratedIE);
  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

/* Today tab: the next days as compact cards, weekend collapsed, holidays, MGM weather chips. */
async function todayTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  for (const c of ['CS 201', 'EE 311', 'MATH 201']) {
    await p.fill('#search', c); await p.waitForTimeout(140);
    const h = p.locator(`#search-results [data-code="${c}"]`).first(); if (await h.count()) { await h.click(); await p.waitForTimeout(150); }
  }
  const setup = (opts) => p.evaluate((o) => {
    const today = istanbulToday();
    const iso = (n) => addDaysISO(today, n);
    App.weather = o.stale ? { updated: new Date(Date.now() - 5 * 86400e3).toISOString(), days: [{ date: today, min: 1, max: 2, code: 'sun', text: 'Clear' }] }
      : { updated: new Date().toISOString(), days: [
        { date: iso(0), min: 14, max: 21, code: 'partly', text: 'Partly cloudy' }, { date: iso(1), min: 13, max: 19, code: 'storm', text: 'Thunderstorms' },
        { date: iso(2), min: 12, max: 18, code: 'rain', text: 'Rain' }, { date: iso(6), min: 9, max: 15, code: 'snow', text: 'Snow' }] };
    App.calendar = { name: 'Test term', classesStart: iso(-30), classesEnd: iso(60), holidays: [{ date: iso(2), name: 'Test Bayramı' }] };
    App.todayDays = o.days || 7;
    store.view = 'today'; renderToday();
    return { today, hol: iso(2) };
  }, opts);
  await p.locator('[data-view="today"]:visible').first().click(); await p.waitForTimeout(300);          // the bottom bar on a phone
  const info = await setup({});
  const cards = await p.$$eval('#today-body .day-card', (n) => n.map((x) => ({ title: x.querySelector('h3').textContent, date: x.querySelector('.day-date').textContent, quiet: x.classList.contains('quiet'), text: x.textContent.replace(/\s+/g, ' ') })));
  check('Today lists the next days as cards (a weekend counts as one)', cards.length >= 5 && cards.length <= 7, JSON.stringify(cards.map((c) => c.title)));
  check('the first two cards are "Today" and "Tomorrow"', cards[0].title === 'Today' && cards[1].title === 'Tomorrow');
  check('at most one "Weekend" card, and only for two quiet days', cards.filter((c) => c.title === 'Weekend').length <= 1 && cards.filter((c) => c.title === 'Weekend').every((c) => / – /.test(c.date)), JSON.stringify(cards.map((c) => c.title)));
  const holiday = cards.find((c) => /Test Bayramı/.test(c.text));
  check('a holiday shows its name and no classes', !!holiday && /Holiday · Test Bayramı/.test(holiday.text) && !(await p.locator('#today-body .day-card', { hasText: 'Test Bayramı' }).locator('.today-row').count()));
  check('weather chips show the high and low with an icon', await p.locator('#today-body .day-card').first().locator('.day-wx svg').count() === 1 && /21°\s*14°/.test(cards[0].text), cards[0].text);
  check('…and a day with no forecast shows none', (await p.locator('#today-body .day-wx').count()) <= 4);
  const rows = await p.locator('#today-body .today-row').count();
  check('class rows are listed under their days', rows >= 1, `${rows} rows`);
  check('days with nothing say so in one line', cards.some((c) => c.quiet && /No classes|Weekend|Holiday/.test(c.text)));
  await p.locator('#today-more').click(); await p.waitForTimeout(200);
  check('"Show the next 7 days" extends the list', (await p.locator('#today-body .day-card').count()) > cards.length);
  await setup({ stale: true });
  check('a forecast older than three days is not shown', (await p.locator('#today-body .day-wx').count()) === 0);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  check('nothing scrolls sideways on a phone', wide);
  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

/* "or" rules from data/programs/overrides.json: MATH 212 vs MATH 201 + 202 (by entry term), and EE core credits from EE 4xx.
 * Runs the real overrides over a made-up BSEE page, so it doesn't depend on what has been scraped. */
async function rulesTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  const run = (entry, taken, opts = {}) => p.evaluate(async ([entry, taken, opts]) => {
    const overrides = await loadOverrides();
    const credits = { 'EE 311': [6, 3], 'EE 411': [6, 3], 'EE 412': [6, 3], 'EE 413': [6, 3], 'MATH 212': [7, 4], 'MATH 201': [6, 3], 'MATH 202': [6, 3] };
    const page = { groups: [
      { name: 'Required Courses', kind: 'required', ...(opts.econ ? {} : { credits: 33, minCourses: 4 }), courses: opts.noMath ? ['EE 201'] : ['EE 201', 'MATH 201', 'MATH 202', ...(opts.econ ? ['MATH 203'] : []), 'MATH 212'] },
      { name: 'Core Electives', kind: 'core', credits: 12, courses: ['EE 311', 'EE 411', 'EE 412', 'EE 413'] }] };
    const patched = applyOverrides(page, opts.program || 'BSEE', entry, overrides);
    planState().terms = [{ id: '202601', courses: taken.map((code) => ({ code, grade: 'A' })) }];
    const req = requirementProgress({ ...patched, credits });
    const out = {};
    const left = (req.find((r) => r.group.kind === 'required') || {}).missing || [];
    req.forEach((r) => { out[r.group.kind] = (r.rules || []).map((x) => `${x.met ? 'met' : x.planned ? 'planned' : 'open'}:${x.label}`); });
    return { rules: out, notes: patched.notes || [], left };
  }, [entry, taken, opts]);

  let r = await run('202402', ['MATH 201']);
  check('entered ≤ Spring 2024-25: "MATH 212, or MATH 201 + MATH 202" is open with only MATH 201', JSON.stringify(r.rules.required) === '["open:MATH 212, or MATH 201 + MATH 202"]', JSON.stringify(r.rules.required));
  check('…and carries its note', r.notes.length === 1 && /isn't required if you take MATH 201 and MATH 202/.test(r.notes[0]), JSON.stringify(r.notes));
  r = await run('202402', ['MATH 201', 'MATH 202']);
  check('…MATH 201 + MATH 202 satisfy it without MATH 212', JSON.stringify(r.rules.required) === '["met:MATH 212, or MATH 201 + MATH 202"]', JSON.stringify(r.rules.required));
  r = await run('202402', ['MATH 212']);
  check('…and so does MATH 212 alone', JSON.stringify(r.rules.required) === '["met:MATH 212, or MATH 201 + MATH 202"]');
  r = await run('202501', ['MATH 201', 'MATH 202']);
  check('entered Fall 2025 or later: MATH 201 + 202 no longer replace MATH 212', JSON.stringify(r.rules.required) === '["open:MATH 212 is required"]', JSON.stringify(r.rules.required));
  r = await run('202501', ['MATH 212']);
  check('…and MATH 212 meets it', JSON.stringify(r.rules.required) === '["met:MATH 212 is required"]' && r.notes.length === 1, JSON.stringify(r));
  r = await run('202501', ['MATH 203'], { program: 'BAECON', econ: true });
  check('ECON: pick-one math set replaces the MATH 212 rule — one rule line, met by MATH 203',
    JSON.stringify(r.rules.required) === '["met:Only 1 of MATH 201 / MATH 202 / MATH 203 / MATH 212 is required — the others are optional"]' && r.notes.length === 1, JSON.stringify(r));
  r = await run('202501', [], { program: 'BAECON', econ: true });
  check('ECON: with none taken the rule is open and "Left" shows a single "1 of …" entry', /^open:Only 1 of/.test(r.rules.required[0]) && r.left.filter((x) => /^1 of MATH 201/.test(x)).length === 1 && !r.left.includes('MATH 212'), JSON.stringify(r));
  r = await run('202402', [], { noMath: true });
  check('a programme that doesn\'t list MATH 212 gets neither the rule nor the note', !(r.rules.required || []).length && !r.notes.length, JSON.stringify(r));
  r = await run('202602', ['EE 311', 'EE 411']);
  check('EE core: 9 credits from EE 4xx — 3/9 so far (EE 311 doesn\'t count)', JSON.stringify(r.rules.core) === '["planned:At least 9 credits from EE 4xx courses — 3/9 cr"]', JSON.stringify(r.rules.core));
  r = await run('202602', ['EE 411', 'EE 412', 'EE 413']);
  check('…met with three EE 4xx courses', JSON.stringify(r.rules.core) === '["met:At least 9 credits from EE 4xx courses — 9/9 cr"]', JSON.stringify(r.rules.core));
  r = await run('202602', ['EE 411', 'EE 412', 'EE 413'], { program: 'BSCS' });
  check('…and it is an EE-only rule', !(r.rules.core || []).length, JSON.stringify(r.rules.core));
  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

async function deptRulesTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  // one synthetic programme page through the real overrides; `taken` are graded courses
  const run = (program, groups, taken) => p.evaluate(async ([program, groups, taken]) => {
    const overrides = await loadOverrides();
    const patched = applyOverrides({ groups }, program, '202602', overrides);
    planState().terms = [{ id: '202601', courses: taken.map((code) => ({ code, grade: 'A' })) }];
    const req = requirementProgress({ ...patched, credits: {} });
    const out = {};
    req.forEach((r) => { out[r.group.name] = { rules: (r.rules || []).map((x) => `${x.bad ? 'bad' : x.met ? 'met' : x.planned ? 'planned' : 'open'}:${x.label}`),
      matches: r.matches.map((m) => m.code), note: r.group.note || '' }; });
    return out;
  }, [program, groups, taken]);
  const fac = (courses) => ({ name: 'Faculty Courses', kind: 'faculty', minCourses: 5, courses });
  const FAC = ['CS 201', 'MATH 201', 'MATH 202', 'ENS 201', 'ECON 201', 'ECON 202', 'ECON 204', 'PSY 201', 'VA 201', 'ACC 201', 'FIN 301', 'HART 292', 'IR 201', 'POLS 250', 'SOC 201'];

  let r = await run('BSCS', [fac(FAC)], ['MATH 201', 'MATH 202', 'CS 201', 'ENS 201', 'ECON 201']);
  check('FENS-type faculty: 2 MATH + 3 FENS-pool courses met', JSON.stringify(r['Faculty Courses'].rules) === '["met:At least 2 MATH-coded courses — 2/2","met:At least 3 courses from the FENS Faculty pool — 4/3"]', JSON.stringify(r['Faculty Courses'].rules));
  check('…and the degree page note is attached', /at least 2 of these courses must be MATH coded/i.test(r['Faculty Courses'].note));
  r = await run('BSMAT', [fac(FAC)], ['MATH 201', 'CS 201', 'ECON 201', 'ECON 202', 'PSY 201']);
  check('FENS-type faculty: only 1 MATH and 2 FENS-pool courses -> both rules open', JSON.stringify(r['Faculty Courses'].rules) === '["planned:At least 2 MATH-coded courses — 1/2","planned:At least 3 courses from the FENS Faculty pool — 2/3"]', JSON.stringify(r['Faculty Courses'].rules));
  r = await run('BSMS-DM', [fac(FAC)], ['MATH 201', 'MATH 202', 'CS 201']);
  check('…the double-major variant gets the same rules', r['Faculty Courses'].rules.length === 2);

  r = await run('BAECON', [fac(FAC)], ['ECON 201', 'ECON 202', 'PSY 201', 'CS 201']);
  check('FASS-type faculty: 3 FASS courses over 3 areas (ECON, PSYCH, FENS) met', JSON.stringify(r['Faculty Courses'].rules) === '["met:At least 3 courses from the FASS Faculty pool — 3/3","met:The courses spread over at least 3 of the 8 areas — 3/3"]', JSON.stringify(r['Faculty Courses'].rules));
  r = await run('BAPSIR', [fac(FAC)], ['ECON 201', 'ECON 202', 'ECON 204']);
  check('…three ECON courses are 3 FASS courses but only 1 area', JSON.stringify(r['Faculty Courses'].rules) === '["met:At least 3 courses from the FASS Faculty pool — 3/3","planned:The courses spread over at least 3 of the 8 areas — 1/3"]', JSON.stringify(r['Faculty Courses'].rules));
  r = await run('BAVACD', [fac(FAC)], ['ECON 201', 'IR 201', 'POLS 250', 'SOC 201']);
  check('…IR / POLS / SOC all count as the one SPS/POLS/IR area (ECON + that = 2 areas)', /— 2\/3/.test(r['Faculty Courses'].rules[1]), JSON.stringify(r['Faculty Courses'].rules));
  r = await run('BAMAN', [fac(FAC)], ['ACC 201', 'FIN 301', 'CS 201']);
  check('BAMAN faculty: 2 SOM courses met', JSON.stringify(r['Faculty Courses'].rules) === '["met:At least 2 courses from the SOM Faculty pool — 2/2"]', JSON.stringify(r['Faculty Courses'].rules));
  r = await run('BSDSA', [fac(FAC)], ['CS 201', 'ECON 201']);
  check('BSDSA faculty: one from each pool — SBS still open', JSON.stringify(r['Faculty Courses'].rules.map((x) => x.split(':')[0])) === '["met","met","open"]', JSON.stringify(r['Faculty Courses'].rules));

  r = await run('BSEE', [fac(FAC)], ['MATH 201', 'MATH 202', 'CS 201', 'ENS 201']);
  check('BSEE faculty: same FENS rules as the other engineering programmes', r['Faculty Courses'].rules.length === 2 && r['Faculty Courses'].rules.every((x) => x.startsWith('met:')), JSON.stringify(r['Faculty Courses'].rules));
  const eeArea = { name: 'Area Electives', kind: 'area', credits: 9, courses: ['CS 300', 'EE 48011', 'EE 401', 'CS 401'] };
  r = await run('BSEE', [eeArea], ['EE 401']);
  check('BSEE area: the special-courses condition is open with only EE 401', /^open:At least 1 course from CS 300/.test(r['Area Electives'].rules[0]), JSON.stringify(r['Area Electives'].rules));
  r = await run('BSEE', [eeArea], ['EE 401', 'EE 48011']);
  check('…and met by an EE 48XXX special topics course', /^met:At least 1 course from CS 300/.test(r['Area Electives'].rules[0]), JSON.stringify(r['Area Electives'].rules));
  check('…with the degree page note attached', /Special Topics/.test(r['Area Electives'].note));

  const dsaCore = { name: 'Core Electives', kind: 'core', credits: 27, courses: ['CS 306', 'CS 404', 'EE 311', 'ECON 401', 'PSY 306', 'ECON 494', 'OPIM 402', 'MKTG 401', 'ORG 405', 'IE 405', 'OPIM 410'] };
  const dsaArea = { name: 'Area Electives', kind: 'area', credits: 12, courses: ['IE 405', 'OPIM 410', 'CS 300'] };
  r = await run('BSDSA', [dsaCore, dsaArea], ['CS 306', 'CS 404', 'EE 311', 'ECON 401', 'PSY 306', 'ECON 494', 'OPIM 402', 'MKTG 401', 'ORG 405']);
  check('BSDSA core: 3 FENS + 3 FASS + 3 SBS met', JSON.stringify(r['Core Electives'].rules.slice(0, 3)) === '["met:At least 3 FENS courses — 3/3","met:At least 3 FASS courses — 3/3","met:At least 3 SBS courses — 3/3"]', JSON.stringify(r['Core Electives'].rules));
  r = await run('BSDSA', [dsaCore, dsaArea], ['IE 405', 'OPIM 410']);
  check('IE 405 + OPIM 410 together: warned, and only the first one counts anywhere', r['Core Electives'].rules[3].startsWith('bad:') && r['Core Electives'].matches.join() === 'IE 405' && !r['Area Electives'].matches.includes('OPIM 410'), JSON.stringify(r));
  r = await run('BSDSA', [dsaCore, dsaArea], ['OPIM 410']);
  check('…one of them alone is fine', r['Core Electives'].rules[3].startsWith('met:'));

  const baman = [
    { name: 'Core Electives', kind: 'core', credits: 18, minCourses: 6, courses: ['ACC 301', 'FIN 301', 'MGMT 301', 'MKTG 301', 'OPIM 302', 'ORG 301'] },
    { name: 'Area Electives', kind: 'area', credits: 24, courses: ['ACC 410', 'FIN 401', 'MKTG 401', 'OPIM 402', 'ORG 405', 'MGMT 402'] },
    { name: 'Free Electives', kind: 'free', credits: 26, courses: [] }];
  r = await run('BAMAN', baman, ['ACC 301', 'FIN 301', 'MGMT 301', 'MKTG 301']);
  check('BAMAN core: 4/6 areas, missing OPIM and ORG named', r['Core Electives'].rules[0] === 'planned:At least one course from each of ACC, FIN, MGMT, MKTG, OPIM, ORG — 4/6 (missing OPIM, ORG)', r['Core Electives'].rules[0]);
  r = await run('BAMAN', baman, ['ACC 301', 'FIN 301', 'MGMT 301', 'MKTG 301', 'OPIM 302', 'ORG 301']);
  check('…all six subjects met', r['Core Electives'].rules[0].startsWith('met:'));
  r = await run('BAMAN', baman, ['ECON 201', 'CS 201', 'ACC 201']);
  check('BAMAN free: 9 SU from FASS/FENS — ECON + CS are 6, ACC (SBS) doesn\'t count', r['Free Electives'].rules[0] === 'planned:At least 9 SU credits from FASS or FENS courses — 0/9 cr' || /— 6\/9 cr/.test(r['Free Electives'].rules[0]) || /— 0\/9 cr/.test(r['Free Electives'].rules[0]), r['Free Electives'].rules[0]);
  check('…and the language note is attached', /Beginning \/ Basic level language/.test(r['Free Electives'].note));

  const psy = [
    { name: 'Required Courses', kind: 'required', credits: 18, minCourses: 7, courses: ['PSY 201', 'PHIL 300', 'PHIL 301'] },
    { name: 'Area Electives', kind: 'area', credits: 18, courses: ['PSY 303', 'PSY 305', 'PSY 306', 'PSY 311', 'PSY 443', 'PSY 452', 'PSY 316'] }];
  r = await run('BAPSY', psy, ['PHIL 301']);
  check('BAPSY: either PHIL 300 or PHIL 301 meets the philosophy requirement', r['Required Courses'].rules[0] === 'met:Philosophy requirement: either PHIL 300 or PHIL 301', JSON.stringify(r['Required Courses'].rules));
  r = await run('BAPSY', psy, ['PSY 303', 'PSY 305', 'PSY 306', 'PSY 311', 'PSY 443']);
  check('BAPSY area: 5 PSY courses, 1 of them 4XX — both rules still open', JSON.stringify(r['Area Electives'].rules) === '["planned:At least 6 PSY-coded courses — 5/6","planned:At least 2 courses from PSY 4XX — 1/2"]', JSON.stringify(r['Area Electives'].rules));
  r = await run('BAPSY', psy, ['PSY 303', 'PSY 305', 'PSY 306', 'PSY 311', 'PSY 443', 'PSY 452']);
  check('…6 PSY courses with two 4XX meet both', r['Area Electives'].rules.every((x) => x.startsWith('met:')), JSON.stringify(r['Area Electives'].rules));

  const vacd = [
    { name: 'Required Courses', kind: 'required', credits: 15, courses: ['VA 201', 'VA 203', 'VA 300', 'VA 301', 'VA 303', 'VA 401', 'VA 403'] },
    { name: 'Core Electives II (Skill Courses)', kind: 'core', credits: 12, courses: ['VA 202', 'VA 302', 'VA 304', 'VA 402', 'VA 404'] }];
  r = await run('BAVACD', vacd, ['PROJ 300', 'VA 303', 'VA 401']);
  check('BAVACD required: PROJ 300 stands in for VA 300, VA 303 for VA 301, VA 401 for itself', JSON.stringify(r['Required Courses'].rules.map((x) => x.split(':')[0])) === '["met","met","met"]' && r['Required Courses'].matches.length === 3, JSON.stringify(r['Required Courses']));
  r = await run('BAVACD', vacd, ['VA 301', 'VA 303']);
  check('…taking both VA 301 and VA 303 counts only one', r['Required Courses'].matches.join() === 'VA 301', JSON.stringify(r['Required Courses'].matches));
  r = await run('BAVACD', vacd, ['VA 302', 'VA 304', 'VA 402']);
  check('BAVACD skill electives: VA 302 + VA 304 warned, VA 402 alone fine', JSON.stringify(r['Core Electives II (Skill Courses)'].rules.map((x) => x.split(':')[0])) === '["bad","met"]' && r['Core Electives II (Skill Courses)'].matches.join() === 'VA 302,VA 402', JSON.stringify(r['Core Electives II (Skill Courses)']));

  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

async function minorsTest() {
  const log = []; const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`);
  const b = await chromium.launch(launchOptions());
  const p = await (await b.newContext({ viewport: { width: 1360, height: 950 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto('file://' + path.resolve(root, 'dist/sumods.html')); await p.waitForSelector('#grid .tt');
  const opts = (sel) => p.$$eval(`${sel} option`, (o) => o.map((x) => x.value).filter(Boolean));
  const headings = async () => (await p.$$eval('#plan-body .side-head', (n) => n.map((x) => x.textContent.trim().replace(/\s+/g, ' '))));
  await p.locator('.tabs [data-view="plan"]').click(); await p.waitForTimeout(400);
  await p.selectOption('#plan-program', 'BSEE'); await p.waitForTimeout(300);
  await p.selectOption('#plan-program2', 'BSMAT-DM'); await p.waitForTimeout(500);

  check('minors are in neither the main nor the double-major picker',
    !(await opts('#plan-program')).some((c) => /MINOR/.test(c)) && !(await opts('#plan-program2')).some((c) => /MINOR/.test(c)));
  check('"Add minor" offers both minors', JSON.stringify(await opts('#plan-minor-add')) === '["MATH-MINOR","PHIL-MINOR"]', JSON.stringify(await opts('#plan-minor-add')));

  await p.selectOption('#plan-minor-add', 'PHIL-MINOR'); await p.waitForTimeout(500);
  check('the added minor shows as a chip and leaves the "Add minor" list',
    (await p.locator('.minor-chip', { hasText: 'Philosophy' }).count()) === 1 && JSON.stringify(await opts('#plan-minor-add')) === '["MATH-MINOR"]',
    JSON.stringify(await opts('#plan-minor-add')));
  await p.selectOption('#plan-minor-add', 'MATH-MINOR'); await p.waitForTimeout(500);
  check('with every minor added the "Add minor" picker is gone', (await p.locator('#plan-minor-add').count()) === 0);

  const heads = await headings();
  check('requirements read main programme, double major, then the minors',
    heads.length === 4 && /\(primary\)/.test(heads[0]) && /\(double major\)/.test(heads[1]) && /Philosophy \(minor\)/.test(heads[2]) && /Mathematics \(minor\)/.test(heads[3]), JSON.stringify(heads));
  const planText = (await p.locator('#plan-body').textContent()).replace(/\s+/g, ' ');
  check('a minor says what it needs', /The minor needs 18 SU credits/.test(planText) && !/Graduation needs 18 SU/.test(planText));

  // courses in the plan count towards a minor
  await p.evaluate(() => { const plan = planState(); plan.terms = [{ id: '202601', courses: [{ code: 'HUM 207', grade: 'A' }, { code: 'PHIL 300' }, { code: 'PHIL 301' }, { code: 'MATH 201' }] }]; save(); renderPlanner(); });
  await p.waitForTimeout(300);
  const philReq = await p.evaluate(() => { const r = requirementProgress(minorPrograms()[0]); return r.map((x) => [x.group.kind, x.matches.map((m) => m.code)]); });
  check('minor requirements are matched against the plan (required / core / spill into area)',
    JSON.stringify(philReq) === '[["required",["HUM 207"]],["core",["PHIL 300","PHIL 301"]],["area",[]]]', JSON.stringify(philReq));

  // the requirements dialog opens for a minor
  await p.locator('[data-open-req^="m0:"]').first().click(); await p.waitForTimeout(300);
  check('a minor\'s requirement card opens its dialog', /Philosophy/.test(await p.locator('#req-dlg-title').textContent()), await p.locator('#req-dlg-title').textContent());
  await p.keyboard.press('Escape');

  // minors never count as a programme for registration
  const reg = await p.evaluate(() => ({ majors: activePrograms().map((x) => x.code), pair: myPrograms() }));
  check('minors are not majors (registration days, day-one courses)', JSON.stringify(reg.majors) === '["BSEE","BSMAT-DM"]' && !reg.pair.some((c) => /PHIL|MATH/.test(c) && c.length > 4), JSON.stringify(reg));

  // it survives a reload and can be removed (with undo)
  await p.reload(); await p.waitForSelector('.tabs [data-view="plan"]');     // the app reopens on the Plan tab
  await p.locator('.tabs [data-view="plan"]').click(); await p.waitForTimeout(500);
  check('minors survive a reload', JSON.stringify(await p.evaluate(() => planState().minors.map((m) => m.code))) === '["PHIL-MINOR","MATH-MINOR"]');
  await p.locator('[data-minor-remove="PHIL-MINOR"]').click(); await p.waitForTimeout(400);
  check('removing a minor drops its chip and its requirements',
    JSON.stringify(await p.evaluate(() => planState().minors.map((m) => m.code))) === '["MATH-MINOR"]' && !(await headings()).some((h) => /Philosophy/.test(h)), JSON.stringify(await headings()));
  check('…and it is offered again under "Add minor"', JSON.stringify(await opts('#plan-minor-add')) === '["PHIL-MINOR"]', JSON.stringify(await opts('#plan-minor-add')));
  await p.locator('#toast-host button', { hasText: 'Undo' }).click(); await p.waitForTimeout(400);
  check('Undo puts it back', JSON.stringify(await p.evaluate(() => planState().minors.map((m) => m.code))) === '["PHIL-MINOR","MATH-MINOR"]');

  // the course finder can filter by a minor's requirement
  const finder = await p.evaluate(() => finderRequirementOptions());
  check('the course finder lists minor requirements', /value="m0:0"/.test(finder) && /PHIL-MINOR · Required Courses/.test(finder));
  check('…and filters by them', await p.evaluate(() => countsToward('PHIL 202', 'm0:0') && !countsToward('CS 201', 'm0:0')));
  console.log(log.join('\n')); console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  return log.some((l) => l.startsWith('FAIL')) || errs.length ? 1 : 0;
}

(async () => {
  const teardown = setup();
  let failed = 0;
  try {
    failed += await featuresTest();
    failed += await doubleMajorTest();
    failed += await minorsTest();
    failed += await rulesTest();
    failed += await deptRulesTest();
    failed += await todayTest();
  } finally {
    teardown();
  }
  console.log(failed ? 'ui3: FAILURES' : 'ui3: all passed');
  process.exit(failed ? 1 : 0);
})();
