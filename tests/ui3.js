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

const FILES = {
  BSEE: programme('Electronics Engineering', 129, ['EE 311', 'EE 313'], false),
  'BSEE-DM': programme('Electronics Engineering (Double Major)', 70, [], true),
  BSMAT: programme('Materials Science and Nano Engineering', 125, ['MAT 301', 'MAT 306'], false),
  'BSMAT-DM': programme('Materials Science and Nano Engineering (Double Major)', 65, [], true),
  BSCS: programme('Computer Science and Engineering', 125, ['CS 301'], false),
  BSMS: programme('Industrial Engineering', 126, ['IE 301', 'IE 305'], false),
  'BSIE-DM': programme('Industrial Engineering (Double Major)', 60, [], true),   // Industrial's double major is BSIE-DM, not BSMS-DM
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
  const own = await p.evaluate(() => { App.infoAll = { courses: { 'SPS 303': { prereqCodes: [['SPS 303'], ['SPS 303D'], ['MATH 101']] }, 'EE 202': { prereqCodes: [['ENS 203']] }, 'ENS 203': { prereqCodes: [] } } }; return { groups: requirementGroups('SPS 303'), opens: unlockedBy('ENS 203') }; });
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
  check('registration panel shows the IE department for BSIE-DM', (await p.inputValue('#reg-major2')) === 'IE', await p.inputValue('#reg-major2'));
  await p.selectOption('#reg-major2', 'MAT'); await p.waitForTimeout(300);
  await p.selectOption('#reg-major2', 'IE'); await p.waitForTimeout(300);
  check('choosing IE as the double major in the panel gives BSIE-DM', (await p.evaluate(() => planState().program2)) === 'BSIE-DM', await p.evaluate(() => planState().program2));
  const migratedIE = await p.evaluate(async () => { planState().program2 = 'BSMS'; planState().program = 'BSEE'; await refreshRequirements(); return planState().program2; });
  check('an older plan with program2 = BSMS becomes BSIE-DM', migratedIE === 'BSIE-DM', migratedIE);
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
  } finally {
    teardown();
  }
  console.log(failed ? 'ui3: FAILURES' : 'ui3: all passed');
  process.exit(failed ? 1 : 0);
})();
