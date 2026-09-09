#!/usr/bin/env node
/**
 * Stress test for the Ledger dashboard.
 *
 *   npm i -D playwright && node test/stress.js [path/to/index.html]
 *
 * Drives a real Chromium against the single-file app and checks the things that
 * have actually broken before: silent data corruption in the CSV parser, HTML
 * injection through imported fields, credentials riding along in shared exports,
 * layout that clips numbers or scrolls the page sideways, and saves that fail
 * without saying so. Exits non-zero if any check fails.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const CHROME = process.env.CHROME_PATH || undefined;   // let Playwright resolve it by default
const PORT = 8899 + Math.floor(Math.random() * 400);

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); };

// ---- a file:// origin gives localStorage odd behaviour, so serve over http ----
function serve(dir) {
  const types = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(PORT, () => r(srv)));
}

async function newPage(browser, viewport = { width: 1280, height: 900 }, url = null) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url || `http://localhost:${PORT}/${path.basename(FILE)}`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { ctx, page, logs };
}

const loadDemo = async page => {
  await page.click('[data-act="demo"]');
  await page.waitForSelector('#m-review.open');
  await page.click('[data-act="commit"]');
  await page.waitForTimeout(600);
};
const section = async (page, k) => {
  await page.evaluate(s => document.querySelector(`#subnav [data-section="${s}"]`)?.click(), k);
  await page.waitForTimeout(450);
};
const download = async (page, act, dir) => {
  const wait = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  await page.evaluate(a => document.querySelector(`[data-act="${a}"]`)?.click(), act);
  const d = await wait;
  if (!d) return null;
  const out = path.join(dir, d.suggestedFilename());
  await d.saveAs(out);
  return out;
};

// ---------------------------------------------------------------- the checks
async function boot(browser) {
  const { ctx, page, logs } = await newPage(browser);
  await loadDemo(page);
  for (const s of ['overview', 'performance', 'risk', 'trends', 'trades']) {
    await section(page, s);
    const len = (await page.$eval('#dash', e => e.innerText)).length;
    check(`renders: ${s}`, len > 200, `${len} chars of text`);
  }
  // The page has to be able to answer "is the version online the current one?" on its own.
  const brand = await page.evaluate(() => (document.getElementById('brand') || {}).title || '');
  check('the build is named on the brand', /^Ledger v\d+\.\d+\.\d+$/.test(brand), brand);
  await page.evaluate(() => document.querySelector('[data-act="settings"]')?.click());
  await page.waitForTimeout(400);
  const line = await page.evaluate(() => (document.querySelector('#s-storage') || {}).textContent || '');
  check('and again in Settings', /v\d+\.\d+\.\d+/.test(line), line);
  check('the two agree', (brand.match(/v[\d.]+/) || [])[0] === (line.match(/v[\d.]+/) || [])[1 - 1], `${brand} / ${line}`);
  check('no console errors on boot', logs.length === 0, logs.slice(0, 3).join(' | '));
  await ctx.close();
}

async function parsing(browser) {
  const { ctx, page } = await newPage(browser);
  const r = await page.evaluate(() => {
    const one = v => { const x = CORE.importText(`Date,P&L\n2024-03-01,"${v}"\n`); return x.trades[0] ? x.trades[0].pnl : 'unreadable'; };
    return {
      money: {
        '1,234.56': one('1,234.56'), '1.234,56': one('1.234,56'), '1 234,56': one('1 234,56'),
        '(500)': one('(500)'), '500 DR': one('500 DR'), '£1,000': one('£1,000'),
        '−2500': one('−2500'), '1e3': one('1e3'), '1e999': one('1e999'), 'abc': one('abc'),
      },
      dmy: CORE.importText('Date,P&L\n14/03/2024,10\n').trades[0].date,
      mdy: CORE.importText('Date,P&L\n03/14/2024,10\n').trades[0].date,
      iso: CORE.importText('Date,P&L\n2024-03-14,10\n').trades[0].date,
      semicolon: CORE.importText('Date;Symbol;P&L\n01.03.2024;ES;1.234,56\n').trades[0].pnl,
      tabs: CORE.importText('Date\tP&L\n2024-03-01\t5\n').trades[0].pnl,
      preamble: CORE.importText('Broker export\nrun 2024\n\nDate,P&L\n2024-03-01,5\n').trades.length,
      noHeader: CORE.importText('a,b,c\n1,2,3\n').error !== '',
      empty: CORE.importText('').error !== '',
    };
  });
  const want = { '1,234.56': 1234.56, '1.234,56': 1234.56, '1 234,56': 1234.56, '(500)': -500, '500 DR': -500, '£1,000': 1000, '−2500': -2500, '1e3': 1000, '1e999': 'unreadable', 'abc': 'unreadable' };
  for (const [k, v] of Object.entries(want)) check(`parseMoney ${JSON.stringify(k)} -> ${v}`, r.money[k] === v, `got ${r.money[k]}`);
  check('date DMY', r.dmy === '2024-03-14', r.dmy);
  check('date MDY auto-detect', r.mdy === '2024-03-14', r.mdy);
  check('date ISO', r.iso === '2024-03-14', r.iso);
  check('semicolon + comma decimals', r.semicolon === 1234.56, String(r.semicolon));
  check('tab delimited', r.tabs === 5, String(r.tabs));
  check('header below preamble', r.preamble === 1, String(r.preamble));
  check('rejects file with no date/pnl column', r.noHeader);
  check('rejects empty input', r.empty);
  await ctx.close();
}

// Every string a trade carries reaches innerHTML somewhere. None may become an element.
async function injection(browser) {
  const props = ['instrument', 'direction', 'currency', 'size', 'reference', 'account', 'tag', 'time'];
  for (const prop of props) {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(p => {
      const trades = [1, 2, 3, 4].map(i => {
        const t = { date: `2024-03-0${i}`, time: '10:00', instrument: 'ES', direction: i % 2 ? 'BUY' : 'SELL', size: '1',
          currency: 'USD', pnl: i % 2 ? 100 : -40, reference: 'R' + i, openTs: `2024-03-0${i}T09:00:00Z`,
          closeTs: `2024-03-0${i}T10:00:00Z`, kind: 'trade', account: 'Main', tag: 'Breakout',
          risk: 50, stop: 1, openLevel: 100, closeLevel: 110, id: 'id' + i };
        t[p] = '<b class="pwn">x</b>';
        return t;
      });
      localStorage.setItem('ledger:v4', JSON.stringify({ trades, theme: 'dark', settings: { tags: ['Breakout'] }, section: 'overview' }));
    }, prop);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(600);
    let hits = await page.evaluate(() => document.querySelectorAll('b.pwn').length);
    for (const s of ['performance', 'risk', 'trends', 'trades']) {
      await section(page, s);
      hits += await page.evaluate(() => document.querySelectorAll('b.pwn').length);
    }
    check(`no HTML injection via ${prop}`, hits === 0, `${hits} injected elements`);
    await ctx.close();
  }
}

async function exportsAndSecrets(browser, tmp) {
  const { ctx, page } = await newPage(browser);
  await loadDemo(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.syncUrl = 'https://canary.example.workers.dev';
    s.settings.syncToken = 'CANARY-TOKEN-DO-NOT-SHARE';
    localStorage.setItem('ledger:v4', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);

  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(250);
  const snap = await download(page, 'snapshot', tmp);
  check('snapshot downloads', !!snap);
  if (snap) {
    const txt = fs.readFileSync(snap, 'utf8');
    check('snapshot carries no sync token', !txt.includes('CANARY-TOKEN-DO-NOT-SHARE'));
    check('snapshot carries no worker URL', !txt.includes('canary.example.workers.dev'));
    // and it must still open as a working read-only page
    fs.copyFileSync(snap, path.join(path.dirname(FILE), '__snap_test.html'));
    const { ctx: c2, page: p2, logs: l2 } = await newPage(browser, undefined, `http://localhost:${PORT}/__snap_test.html`);
    await p2.waitForTimeout(900);
    const ro = await p2.evaluate(() => ({ ro: document.body.classList.contains('ro'), rows: document.querySelectorAll('#table tbody tr').length }));
    check('snapshot opens read-only with data', ro.ro && ro.rows > 0, JSON.stringify(ro));
    check('snapshot has no console errors', l2.length === 0, l2.slice(0, 2).join(' | '));
    await c2.close();
    fs.unlinkSync(path.join(path.dirname(FILE), '__snap_test.html'));
  }

  const csv = await download(page, 'export', tmp);
  check('CSV downloads', !!csv);
  if (csv) {
    const txt = fs.readFileSync(csv, 'utf8');
    const rt = await page.evaluate(t => {
      const before = JSON.parse(localStorage.getItem('ledger:v4')).trades;
      const re = CORE.importText(t, {});
      const both = k => [before.filter(x => x[k]).length, re.trades.filter(x => x[k]).length];
      return { n: [before.length, re.trades.length], openTs: both('openTs'), closeTs: both('closeTs'), tag: both('tag'), err: re.error };
    }, txt);
    check('CSV round-trip keeps every row', rt.n[0] === rt.n[1], JSON.stringify(rt.n));
    for (const k of ['openTs', 'closeTs', 'tag'])
      check(`CSV round-trip keeps ${k}`, rt[k][0] === rt[k][1], `${rt[k][0]} -> ${rt[k][1]}`);
  }

  const img = await download(page, 'image', tmp);
  check('calendar image exports', !!img && fs.readFileSync(img).slice(0, 8).toString('hex') === '89504e470d0a1a0a');
  await ctx.close();
}

async function layout(browser) {
  for (const w of [320, 390, 768, 1010, 1024, 1440, 1920]) {
    const { ctx, page } = await newPage(browser, { width: w, height: 900 });
    await loadDemo(page);
    // a six-figure account is where clipping shows up
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('ledger:v4'));
      s.trades = s.trades.map(t => ({ ...t, pnl: t.pnl * 137.4 }));
      s.settings.balance = '250000';
      localStorage.setItem('ledger:v4', JSON.stringify(s));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const clipped = [];
      document.querySelectorAll('#dash *').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || !el.clientWidth) return;
        if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll')
          clipped.push((el.textContent || '').trim().slice(0, 30));
      });
      const tabs = document.querySelector('#tabs'), act = tabs?.querySelector('.tab.active');
      let visible = true;
      if (tabs && act) { const t = tabs.getBoundingClientRect(), a = act.getBoundingClientRect(); visible = a.left >= t.left - 1 && a.right <= t.right + 1; }
      return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped: clipped.slice(0, 3), visible };
    });
    check(`${w}px: no horizontal page scroll`, r.over === 0, `${r.over}px overflow`);
    check(`${w}px: no clipped values`, r.clipped.length === 0, r.clipped.join(' | '));
    check(`${w}px: selected timeframe visible`, r.visible);
    await ctx.close();
  }
}

async function palette(browser) {
  const { ctx, page } = await newPage(browser);
  await loadDemo(page);
  const apply = async k => {
    await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
    await page.waitForTimeout(250);
    await page.selectOption('#s-palette', k);
    await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
    await page.waitForTimeout(700);
  };
  const keys = await page.evaluate(async () => {
    document.querySelector('[data-act="settings"]').click();
    await new Promise(r => setTimeout(r, 250));
    const ks = Array.from(document.querySelectorAll('#s-palette option')).map(o => o.value).filter(v => v !== 'custom');
    document.querySelector('[data-act="close"]').click();
    return ks;
  });
  check('palette presets are offered', keys.length >= 2, keys.join(','));
  for (const k of keys) {
    await apply(k);
    await section(page, 'trends');
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const cv = document.querySelector('#c-cmp');
      const ch = cv && window.Chart ? Chart.getChart(cv) : null;
      return { profit: cs.getPropertyValue('--profit').trim(), loss: cs.getPropertyValue('--loss').trim(),
        compare: cs.getPropertyValue('--compare').trim(), series: ch ? ch.data.datasets.map(d => d.borderColor) : null };
    });
    const distinct = new Set([r.profit, r.loss, r.compare].map(String));
    check(`palette ${k}: profit/loss/compare all distinct`, distinct.size === 3, JSON.stringify(r));
    if (r.series) check(`palette ${k}: comparison series distinguishable`, r.series[0] !== r.series[1], r.series.join(' vs '));
    await section(page, 'overview');
    const legend = await page.evaluate(() => Array.from(document.querySelectorAll('.legend i')).slice(0, 2).map(e => getComputedStyle(e).borderColor));
    const chan = hex => { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', '); };
    check(`palette ${k}: legend swatches follow the palette`,
      legend[0].includes(chan(r.profit)) && legend[1].includes(chan(r.loss)), legend.join(' | '));
  }
  // survives a reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const kept = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--profit').trim());
  check('custom palette survives reload', !!kept);
  await ctx.close();
}

async function storageAndForm(browser) {
  const { ctx, page } = await newPage(browser);
  await loadDemo(page);
  // a save that cannot happen must say so
  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'ledger:v4') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return real.call(this, k, v);
    };
  });
  await page.evaluate(() => document.querySelector('[data-act="add"]').click());
  await page.waitForTimeout(250);
  await page.fill('#f-symbol', 'TEST');
  await page.fill('#f-pnl', '12.34');
  await page.evaluate(() => document.querySelector('[data-act="submit"]').click());
  await page.waitForTimeout(500);
  const toast = await page.evaluate(() => document.querySelector('#toast').textContent);
  check('failed save warns the user', /storage|saved|backup/i.test(toast), toast.slice(0, 70));
  await ctx.close();

  // the add form must reject nonsense rather than store a wrong number
  const { ctx: c2, page: p2 } = await newPage(browser);
  await loadDemo(p2);
  for (const [val, ok] of [['abc', false], ['1e999', false], ['42.50', true], ['-18', true]]) {
    await p2.evaluate(() => document.querySelector('[data-act="add"]').click());
    await p2.waitForTimeout(200);
    await p2.fill('#f-symbol', 'V' + val.replace(/\W/g, ''));
    await p2.fill('#f-pnl', val);
    await p2.evaluate(() => document.querySelector('[data-act="submit"]').click());
    await p2.waitForTimeout(350);
    const added = await p2.evaluate(s => JSON.parse(localStorage.getItem('ledger:v4')).trades.some(t => t.instrument === s), 'V' + val.replace(/\W/g, ''));
    check(`add form ${ok ? 'accepts' : 'rejects'} P&L ${JSON.stringify(val)}`, added === ok);
    await p2.evaluate(() => document.querySelector('[data-act="close"]')?.click());
    await p2.waitForTimeout(150);
  }
  await c2.close();
}

async function a11y(browser) {
  const { ctx, page } = await newPage(browser);
  await loadDemo(page);
  await page.evaluate(() => document.querySelector('#tabs [data-tf="custom"]')?.click());
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll('button')).filter(b => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.title).length,
    inputs: Array.from(document.querySelectorAll('input:not([type=hidden]),select,textarea'))
      .filter(i => i.type !== 'file' && !i.labels?.length && !i.getAttribute('aria-label') && !i.placeholder)
      .map(i => i.id || i.type),
  }));
  check('every button has an accessible name', r.buttons === 0, `${r.buttons} unnamed`);
  check('every control has a label', r.inputs.length === 0, r.inputs.join(', '));
  await ctx.close();
}

// ---------------------------------------------------------------------- main
(async () => {
  if (!fs.existsSync(FILE)) { console.error(`not found: ${FILE}`); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ledger-stress-'));
  const srv = await serve(path.dirname(FILE));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  console.log(`stress-testing ${FILE}\n`);
  try {
    for (const [label, fn] of [['boot', boot], ['parsing', parsing], ['injection', injection],
      ['exports', b => exportsAndSecrets(b, tmp)], ['layout', layout], ['palette', palette],
      ['storage + form', storageAndForm], ['accessibility', a11y]]) {
      process.stdout.write(`  ${label}… `);
      const before = results.length;
      try { await fn(browser); } catch (e) { check(`${label} suite crashed`, false, String(e.message || e).slice(0, 120)); }
      const run = results.slice(before);
      console.log(`${run.filter(x => x.pass).length}/${run.length}`);
    }
  } finally {
    await browser.close();
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nfailures:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
})();
