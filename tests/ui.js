const { chromium } = require('playwright');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '../dist/sumods.html');
const OUT = path.resolve(__dirname, '../shots');

async function newPage(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.errors = errors;
  return page;
}

async function addCourse(page, code) {
  await page.fill('#search', code);
  await page.waitForTimeout(120);
  const btn = page.locator(`#search-results [data-code="${code}"]`).first();
  if (await btn.count()) await btn.click();
  else console.log('  ! no search hit for', code);
  await page.waitForTimeout(120);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ---------- desktop
  const d = await newPage(browser, 1320, 980);
  await d.goto(FILE);
  await d.waitForSelector('#grid .tt', { timeout: 10000 });
  await d.screenshot({ path: `${OUT}/01-empty-desktop.png` });

  for (const code of ['EE 311', 'MATH 201', 'CS 201', 'NS 101', 'HIST 191']) await addCourse(d, code);
  await d.waitForTimeout(200);
  await d.screenshot({ path: `${OUT}/02-desktop-filled.png` });

  // swap mode: click a CS 201R block
  const blocks = await d.locator('#grid .blk').all();
  console.log('desktop blocks:', blocks.length);
  const rec = d.locator('#grid .blk', { hasText: 'CS 201R' }).first();
  if (await rec.count()) { await rec.click(); await d.waitForTimeout(250); }
  await d.screenshot({ path: `${OUT}/03-desktop-swap.png` });
  const ghosts = await d.locator('#grid .blk.ghost').count();
  console.log('ghost slots:', ghosts);
  if (ghosts) { await d.locator('#grid .blk.ghost').first().click(); await d.waitForTimeout(250); }
  await d.screenshot({ path: `${OUT}/04-desktop-after-swap.png` });

  // optimiser
  await d.click('#act-arrange');
  await d.waitForTimeout(150);
  await d.click('#dlg-arrange [data-day="4"]');
  await d.screenshot({ path: `${OUT}/05-arrange-dialog.png` });
  await d.click('#arrange-run');
  await d.waitForSelector('#arrange-results .option', { timeout: 15000 });
  await d.screenshot({ path: `${OUT}/06-arranged.png` });
  await d.locator('#arrange-results .option').first().click();
  await d.waitForTimeout(500);
  console.log('toast:', await d.locator('.toast').first().textContent().catch(() => '-'));

  // CRN dialog
  await d.click('#act-crn');
  await d.waitForTimeout(200);
  await d.screenshot({ path: `${OUT}/07-crn.png` });
  await d.click('#dlg-crn [data-close]');

  // courses view
  await d.click('[data-view="courses"]');
  await d.waitForTimeout(250);
  await d.locator('.cat-item .cat-head').nth(2).click();
  await d.waitForTimeout(150);
  await d.screenshot({ path: `${OUT}/08-catalog.png` });

  // rooms view
  await d.click('[data-view="rooms"]');
  await d.waitForTimeout(250);
  const room = d.locator('#room-free [data-room]').first();
  if (await room.count()) { await room.click(); await d.waitForTimeout(400); }
  await d.screenshot({ path: `${OUT}/09-rooms.png`, fullPage: false });

  // dark mode on the timetable
  await d.click('[data-view="timetable"]');
  await d.click('#theme-btn'); await d.click('#theme-btn');
  await d.waitForTimeout(250);
  await d.screenshot({ path: `${OUT}/10-dark.png` });

  console.log('desktop errors:', d.errors);

  // ---------- mobile
  const m = await newPage(browser, 390, 844);
  await m.goto(FILE);
  await m.waitForSelector('#grid .tt');
  for (const code of ['EE 311', 'MATH 201', 'CS 201', 'NS 101']) await addCourse(m, code);
  await m.waitForTimeout(250);
  await m.screenshot({ path: `${OUT}/20-mobile.png` });
  await m.screenshot({ path: `${OUT}/21-mobile-full.png`, fullPage: true });
  const mrec = m.locator('#grid .blk', { hasText: 'CS 201R' }).first();
  if (await mrec.count()) { await mrec.click(); await m.waitForTimeout(250); }
  await m.screenshot({ path: `${OUT}/22-mobile-swap.png` });
  console.log('mobile errors:', m.errors);

  await browser.close();
})();
