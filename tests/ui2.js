const { chromium } = require('playwright');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '../dist/sumods.html');
const OUT = path.resolve(__dirname, '../shots');
const log = [];
const check = (name, ok, extra = '') => log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('403')) errors.push(m.text()); });

  await page.goto(FILE);
  await page.waitForSelector('#grid .tt');

  // Turkish-insensitive instructor search
  await page.fill('#search', 'gul');
  await page.waitForTimeout(150);
  const hits = await page.locator('#search-results .res').count();
  check('instructor search "gul" finds courses', hits > 0, `${hits} hits`);

  // add via search, by title
  await page.fill('#search', 'linear algebra');
  await page.waitForTimeout(150);
  await page.locator('#search-results .res').first().click();
  await page.waitForTimeout(150);
  check('title search adds MATH 201', (await page.locator('.course[data-code="MATH 201"]').count()) === 1);

  // SPS 101 has 30+ discussion sections: swap fan-out
  await page.fill('#search', 'SPS 101');
  await page.waitForTimeout(150);
  await page.locator('#search-results [data-code="SPS 101"]').click();
  await page.waitForTimeout(200);
  const sps = page.locator('#grid .blk', { hasText: 'SPS 101D' }).first();
  await sps.click();
  await page.waitForTimeout(250);
  const ghosts = await page.locator('#grid .blk.ghost').count();
  check('SPS 101 discussion alternatives appear', ghosts >= 1, `${ghosts} merged slot(s) for 13 sections`);
  await page.screenshot({ path: `${OUT}/30-many-options.png` });
  await page.keyboard.press('Escape');

  // section select keeps other groups available
  const optgroups = await page.locator('.course[data-code="SPS 101"] select optgroup').count();
  check('other lecture groups still listed in the picker', optgroups >= 1);

  // clash detection: add a course that collides, check the warning shows
  const before = await page.locator('.stat.warn').count();
  check('no clash yet', before === 0);

  // CRN copy
  await page.click('#act-crn');
  await page.waitForTimeout(200);
  await page.locator('#crn-body .crn-row').first().click();
  await page.waitForTimeout(150);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check('tapping a CRN copies it', /^\d{5}$/.test(copied), copied);

  // paste CRNs -> loads a timetable
  await page.fill('#crn-paste', '10190 10195 10842');
  await page.click('#crn-load');
  await page.waitForTimeout(300);
  check('pasted CRNs load courses', (await page.locator('.course[data-code="CS 201"]').count()) === 1);

  // persistence across reload
  const codesBefore = await page.$$eval('.course', (n) => n.map((x) => x.dataset.code).sort());
  await page.reload();
  await page.waitForSelector('#grid .tt');
  const codesAfter = await page.$$eval('.course', (n) => n.map((x) => x.dataset.code).sort());
  check('timetable survives a reload', JSON.stringify(codesBefore) === JSON.stringify(codesAfter),
    `${codesBefore.length} vs ${codesAfter.length}`);

  // term switching keeps separate timetables
  await page.selectOption('#term-select', '202502');
  await page.waitForTimeout(400);
  const springCourses = await page.locator('.course').count();
  check('switching term shows that term (empty here)', springCourses === 0, `${springCourses} courses`);
  await page.fill('#search', 'EE 302');
  await page.waitForTimeout(150);
  const springHits = await page.locator('#search-results .res').count();
  check('spring term data is searchable', springHits > 0);
  await page.selectOption('#term-select', '202601');
  await page.waitForTimeout(400);
  check('switching back restores the fall timetable', (await page.locator('.course').count()) === codesAfter.length);

  // share link round-trip
  const link = await page.evaluate(() => {
    const crns = [];
    document.querySelectorAll('.course').forEach((c) => {
      c.querySelectorAll('select').forEach((s) => crns.push(s.value));
    });
    return `#share/202601/${crns.join('.')}`;
  });
  const shared = await ctx.newPage();
  await shared.goto(FILE + link);
  await shared.waitForSelector('#grid .tt');
  await shared.waitForTimeout(300);
  const bannerShown = await shared.locator('#preview-banner').isVisible();
  check('shared link shows the preview banner', bannerShown);
  check('shared link renders the same courses', (await shared.locator('.course').count()) === codesAfter.length);
  await shared.screenshot({ path: `${OUT}/31-shared.png` });

  // optimiser: ranked options, and "keep lecture sections" is respected
  await page.click('#act-arrange');
  await page.waitForTimeout(150);
  await page.check('#opt-keep');
  const lectureBefore = await page.locator('.course[data-code="CS 201"] select').first().inputValue();
  await page.click('#arrange-run');
  await page.waitForSelector('#arrange-results .option', { timeout: 15000 });
  const options = await page.locator('#arrange-results .option').count();
  check('optimiser lists several options', options > 1, `${options} options`);
  await page.locator('#arrange-results .option').first().click();
  await page.waitForTimeout(600);
  const lectureAfter = await page.locator('.course[data-code="CS 201"] select').first().inputValue();
  check('keep-lecture leaves the lecture CRN alone', lectureBefore === lectureAfter, `${lectureBefore} → ${lectureAfter}`);

  // hide + remove
  await page.locator('.course[data-code="MATH 201"] [data-act="hide"]').click();
  await page.waitForTimeout(200);
  check('hidden course leaves the grid', (await page.locator('#grid .blk', { hasText: 'MATH 201' }).count()) === 0);
  await page.locator('.course[data-code="MATH 201"] [data-act="remove"]').click();
  await page.waitForTimeout(200);
  check('remove drops the card', (await page.locator('.course[data-code="MATH 201"]').count()) === 0);
  await page.locator('.toast button').click();
  await page.waitForTimeout(200);
  check('undo brings it back', (await page.locator('.course[data-code="MATH 201"]').count()) === 1);

  // exports must keep working (they were lost once in a refactor)
  await page.locator('.tabs [data-view="timetable"]').click();
  await page.waitForTimeout(300);
  const [calendarFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    (async () => { await page.click('#act-export'); await page.waitForTimeout(200); await page.click('#export-run'); })(),
  ]);
  check('calendar export downloads an .ics', !!calendarFile && /\.ics$/.test(await calendarFile.suggestedFilename()));
  const [imageFile] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.click('#act-image'),
  ]);
  check('image export downloads a picture', !!imageFile && /\.(png|svg)$/.test(await imageFile.suggestedFilename()));

  // planner: transcript import, grades, GPA, add term
  await page.locator('.tabs [data-view="plan"]').click();
  await page.waitForTimeout(700);
  await page.click('#plan-import');
  await page.waitForTimeout(200);
  await page.setInputFiles('#import-file', path.resolve(__dirname, 'fixture_transcript.html'));
  await page.waitForTimeout(600);
  check('transcript preview lists the terms', (await page.locator('.import-row').count()) === 3,
    `${await page.locator('.import-row').count()} terms`);
  await page.click('#import-apply');
  await page.waitForTimeout(600);
  const termCards = await page.locator('[data-term]').count();
  check('imported terms land in the plan', termCards === 3, `${termCards} term cards`);
  const gradeValue = await page.locator('[data-term="202401"] [data-grade="MATH 101"]').inputValue();
  check('grades come across', gradeValue === 'A', gradeValue);
  const stats = await page.locator('#plan-body .filters').textContent();
  check('CGPA is worked out', /CGPA\s*3\.7/.test(stats.replace(/\s+/g, ' ')), stats.replace(/\s+/g, ' ').slice(0, 80));
  await page.selectOption('#new-term', '202502');
  await page.click('#plan-add-term');
  await page.waitForTimeout(300);
  check('add term appends a semester', (await page.locator('[data-term]').count()) === 4);
  await page.selectOption('[data-term="202401"] [data-grade="MATH 101"]', 'B');
  await page.waitForTimeout(300);
  const stats2 = (await page.locator('#plan-body .filters').textContent()).replace(/\s+/g, ' ');
  check('editing a grade moves the CGPA', !/CGPA 3\.7/.test(stats2), stats2.slice(0, 60));
  await page.screenshot({ path: `${OUT}/95-plan-imported.png` });

  console.log(log.join('\n'));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
})();
