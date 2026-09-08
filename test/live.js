#!/usr/bin/env node
/**
 * Live-tracking stress test: open positions, pending orders, and closing a position.
 *
 *   node test/live.js [path/to/index.html]
 *
 * Stands up a mock IG sync worker on the same origin as the page, so the app's own
 * fetch/render/close path is exercised end to end without touching a real account.
 * Exits non-zero if any check fails.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const PORT = 8900 + Math.floor(Math.random() * 500);
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---- mock worker: /positions /orders /sync /close, plus the page itself ----
let state = {};
let calls = [];
function serve(dir) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (p === '/positions') { calls.push({ p, auth: req.headers.authorization || null });
      return state.posStatus && state.posStatus !== 200 ? json(state.posStatus, { error: 'worker down' })
        : json(200, { fetched: new Date().toISOString(), positions: state.positions || [] }); }
    if (p === '/orders') { calls.push({ p });
      return json(200, { fetched: new Date().toISOString(), orders: state.orders || [] }); }
    if (p === '/sync') { calls.push({ p }); return json(200, { account: 'IG', transactions: [], activity: [] }); }
    if (p === '/candles') { calls.push({ p });
      const out = []; let px = 5000, seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648, seed / 2147483648);
      // end the history at the last closed five-minute boundary, so a bar is genuinely forming
      const stepMs = 3e5;
      const t0 = Math.floor(Date.now() / stepMs) * stepMs - 150 * stepMs;
      for (let i = 0; i < 150; i++) {
        const o = px, c = o + (rnd() - 0.47) * 14;
        out.push({ t: new Date(t0 + i * stepMs).toISOString().slice(0, 19), o: +o.toFixed(1),
          h: +(Math.max(o, c) + rnd() * 6).toFixed(1), l: +(Math.min(o, c) - rnd() * 6).toFixed(1),
          c: +c.toFixed(1), v: Math.round(500 + rnd() * 4000) });
        px = c;
      }
      return json(200, { candles: out, allowance: { remaining: 9400, total: 10000 }, cached: false }); }
    if (p === '/close' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      return req.on('end', () => { calls.push({ p, body, auth: req.headers.authorization || null });
        return state.closeStatus && state.closeStatus !== 200 ? json(state.closeStatus, { error: 'close failed' })
          : json(200, state.closeBody || { dealStatus: 'ACCEPTED', profit: 12.5 }); }); }
    const rel = decodeURIComponent(p).replace(/^\/+/, '') || path.basename(FILE);
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(PORT, () => r(srv)));
}

const POS = [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500', direction: 'BUY', size: 2,
  level: 5000, bid: 5010, offer: 5011, stopLevel: 4980, limitLevel: 5040, contractSize: 1 }];

async function openPage(browser, viewport, touch) {
  const page = await (await browser.newContext({ viewport: viewport || { width: 1400, height: 900 },
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : {}) })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/${path.basename(FILE)}`);
  await page.waitForTimeout(400);
  await page.click('[data-act="demo"]');
  await page.waitForSelector('#m-review.open');
  await page.click('[data-act="commit"]');
  await page.waitForTimeout(400);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.syncUrl = `http://localhost:${p}`; s.settings.syncToken = 'SYNCTOK';
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1000);
  return { page, errs };
}
// scoped to the positions table: the orders card has a tbody of its own
const cells = page => page.evaluate(() => Array.from(document.querySelectorAll('#open [data-sk="positions"] tbody tr'))
  .map(r => Array.from(r.children).map(c => c.innerText.trim())));
const repoll = async page => { await page.evaluate(() => document.querySelector('[data-act="poll-now"]')?.click()); await page.waitForTimeout(2400); };

// ---------------------------------------------------------------- the checks
async function rendering(browser) {
  state = { positions: POS, orders: [] };
  const { page, errs } = await openPage(browser);
  const r = await cells(page);
  check('open positions render', r.length === 1, JSON.stringify(r[0] || null));
  // long 2 @5000, bid 5010, contract size 1 -> +$20; stop 20 points away -> $40 risk
  check('unrealised P&L is right', (r[0] || [])[8] === '+$20.00', (r[0] || [])[8]);
  check('risk from the stop is right', (r[0] || [])[6] === '$40.00', (r[0] || [])[6]);
  check('no page errors with positions open', errs.length === 0, errs.join(' | '));
  await page.context().close();
}

// A stop trailed beyond entry pays out. Counting it as risk overstates the downside.
async function trailedStops(browser) {
  state = { orders: [], positions: [
    { dealId: 'A', market: 'Risk long', direction: 'BUY', size: 1, level: 5000, bid: 5010, offer: 5011, stopLevel: 4980, contractSize: 1 },
    { dealId: 'B', market: 'Locked long', direction: 'BUY', size: 1, level: 5000, bid: 5100, offer: 5101, stopLevel: 5050, contractSize: 1 },
    { dealId: 'C', market: 'Locked short', direction: 'SELL', size: 1, level: 5000, bid: 4900, offer: 4901, stopLevel: 4970, contractSize: 1 },
    { dealId: 'D', market: 'Risk short', direction: 'SELL', size: 1, level: 5000, bid: 4990, offer: 4991, stopLevel: 5025, contractSize: 1 },
  ] };
  const { page } = await openPage(browser);
  const r = await cells(page);
  check('a stop below a long entry is risk', (r[0] || [])[6] === '$20.00', (r[0] || [])[6]);
  check('a stop above a long entry is not risk', (r[1] || [])[6] === '+$50.00', (r[1] || [])[6]);
  check('a stop below a short entry is not risk', (r[2] || [])[6] === '+$30.00', (r[2] || [])[6]);
  check('a stop above a short entry is risk', (r[3] || [])[6] === '$25.00', (r[3] || [])[6]);
  const head = await page.evaluate(() => Array.from(document.querySelectorAll('#open .stat-row > div'))
    .map(d => d.innerText.replace(/\s+/g, ' ')).find(t => /Risk if all stops hit/.test(t)));
  check('headline risk counts only what can be lost', /−\$45\.00/.test(head), head);
  check('headline names what is locked in', /\$80\.00 already locked in/.test(head), head);
  await page.context().close();
}

async function badData(browser) {
  state = { orders: [{ dealId: 'O', market: '<b class="pwn">o</b>', direction: 'BUY', size: 1, orderLevel: 100, bid: 99, offer: 101, orderType: '<b class="pwn">t</b>', timeInForce: 'GOOD_TILL_CANCELLED', stopDistance: 10, scalingFactor: 1 }],
    positions: [
      { ...POS[0], dealId: 'X1', market: '<b class="pwn">x</b>', epic: '<b class="pwn">y</b>' },
      { dealId: 'X2', market: 'Junk', direction: 'BUY', size: 'abc', level: 'oops', bid: {}, offer: [], stopLevel: NaN },
      { dealId: 'X3', market: 'Nulls', direction: null, size: null, level: null, bid: null, offer: null, stopLevel: null },
    ] };
  const { page, errs } = await openPage(browser);
  check('worker data cannot inject HTML', await page.evaluate(() => document.querySelectorAll('b.pwn').length) === 0);
  const r = await cells(page);
  check('malformed rows still render', r.length === 3, `${r.length} rows`);
  const junk = (r[1] || []).join(' ');
  check('non-numeric prices are not printed raw', !/oops|object Object/.test(junk), junk);
  check('no page errors on malformed data', errs.length === 0, errs.join(' | '));

  state = { posStatus: 500 };
  await repoll(page);
  const txt = await page.evaluate(() => document.querySelector('#open')?.innerText || '');
  check('a worker error is surfaced', /error/i.test(txt), txt.slice(0, 60).replace(/\n/g, ' '));
  check('a worker error offers a retry', await page.evaluate(() => !!document.querySelector('[data-act="poll-now"]')));
  await page.context().close();
}

// Closing sends a real market order, so every guard here matters.
async function closing(browser) {
  state = { positions: POS, orders: [] };
  const { page, errs } = await openPage(browser);
  const dialog = async () => { await page.evaluate(() => document.querySelector('.closebtn')?.click()); await page.waitForTimeout(300); };
  const go = async () => { await page.evaluate(() => document.querySelector('[data-go]')?.click()); await page.waitForTimeout(1100); };

  await dialog();
  const text = await page.evaluate(() => document.querySelector('.overlay.open .modal')?.innerText.replace(/\s+/g, ' ') || '');
  check('the dialog states it cannot be undone', /cannot be undone/i.test(text), text.slice(0, 80));
  check('the dialog names the closing direction', /closing with a SELL/.test(text), text.slice(0, 120));

  calls = [];
  await go();
  check('no order is sent without a token', calls.filter(c => c.p === '/close').length === 0);
  check('a missing token is reported', /token/i.test(await page.evaluate(() => document.querySelector('#close-err')?.textContent || '')));

  calls = [];
  await page.fill('#ct', 'CLOSETOK');
  await page.evaluate(() => { const g = document.querySelector('[data-go]'); g.click(); g.click(); g.click(); });
  await page.waitForTimeout(1500);
  const sent = calls.filter(c => c.p === '/close');
  check('three clicks send exactly one order', sent.length === 1, `${sent.length} requests`);
  const body = sent[0] ? JSON.parse(sent[0].body) : {};
  check('the order names the position', body.dealId === 'D1' && body.size === 2, JSON.stringify(body));
  check('the order carries the close token', sent[0] && sent[0].auth === 'Bearer CLOSETOK', sent[0] && sent[0].auth);
  check('the close token is not written to storage',
    !(await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.closeToken)));
  check('success is only claimed on IG confirming',
    /IG confirmed/.test(await page.evaluate(() => document.querySelector('#toast').textContent)));
  check('the toast shows the market name unescaped',
    !/&amp;|&lt;/.test(await page.evaluate(() => document.querySelector('#toast').textContent)));

  await page.waitForTimeout(600);
  state = { positions: POS, orders: [], closeBody: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } };
  await dialog(); await go();
  check('a rejection is shown and can be retried', await page.evaluate(() =>
    /rejected/i.test(document.querySelector('#close-err')?.textContent || '') && !document.querySelector('[data-go]')?.disabled));

  state = { positions: POS, orders: [], closeBody: { dealStatus: 'UNCONFIRMED', reason: 'no confirmation' } };
  await go();
  check('an unconfirmed close blocks a retry', await page.evaluate(() => !!document.querySelector('[data-go]')?.disabled));
  await page.evaluate(() => document.querySelector('[data-x]')?.click());

  calls = [];
  state = { positions: POS, orders: [], closeStatus: 500 };
  await dialog(); await go(); await go();
  const keys = calls.filter(c => c.p === '/close').map(c => JSON.parse(c.body).idempotencyKey);
  check('a retry reuses the same idempotency key', keys.length === 2 && keys[0] === keys[1], keys.join(' '));
  await page.evaluate(() => document.querySelector('[data-x]')?.click());
  await page.waitForTimeout(300);
  calls = [];
  await dialog(); await go();
  const k2 = calls.filter(c => c.p === '/close').map(c => JSON.parse(c.body).idempotencyKey)[0];
  check('a fresh dialog uses a fresh key', k2 && k2 !== keys[0], `${k2} vs ${keys[0]}`);
  check('no page errors through the close flow', errs.length === 0, errs.join(' | '));
  await page.context().close();
}

// Positions priced in another currency are only totalled once you supply a rate.
async function foreignCurrency(browser) {
  state = { orders: [], positions: [
    { dealId: 'U', market: 'US 500', direction: 'BUY', size: 1, level: 5000, bid: 5010, offer: 5011, stopLevel: 4990, contractSize: 1, currency: 'USD' },
    { dealId: 'S', market: 'Singapore Blue Chip', direction: 'BUY', size: 2, level: 300, bid: 310, offer: 311, stopLevel: 295, contractSize: 1, currency: 'SGD' },
  ] };
  const { page, errs } = await openPage(browser);
  const head = () => page.evaluate(() => Array.from(document.querySelectorAll('#open .stat-row > div'))
    .map(d => d.innerText.replace(/\s+/g, ' ')));
  let h = await head();
  check('an unconverted position is kept out of the total', /\+\$10\.00/.test(h[0]) && /not totalled/.test(h[0]), h[0]);
  check('the risk total says it covers one currency only', /USD positions only/.test(h[1]), h[1]);
  let r = await cells(page);
  check('an unconverted row shows its own currency', /S\$/.test((r[1] || []).join(' ')), (r[1] || []).join(' '));

  // the settings panel offers exactly the currencies that need a rate
  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(300);
  const offered = await page.evaluate(() => Array.from(document.querySelectorAll('#s-fx [data-fx]')).map(i => i.dataset.fx));
  check('a rate is offered for the foreign currency only', offered.join(',') === 'SGD', offered.join(','));

  // rubbish rates are dropped, a sane one is kept
  for (const [label, v] of [['0', '0'], ['a negative', '-2'], ['an absurd', '1e12']]) {
    await page.fill('#fx-SGD', v);
    await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
    await page.waitForTimeout(700);
    const fx = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.fx);
    check(`${label} rate is not stored`, !fx.SGD, JSON.stringify(fx));
    await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
    await page.waitForTimeout(300);
  }
  await page.fill('#fx-SGD', '0.75');
  await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(900);

  r = await cells(page); h = await head();
  // SGD 20 unrealised at 0.75 -> $15; SGD 10 risk -> $7.50; plus the USD position's $10 each
  check('a converted row is shown in the account currency', /\+\$15\.00/.test((r[1] || []).join(' ')), (r[1] || []).join(' '));
  check('a converted row is tagged fx', /fx/.test((r[1] || [])[0] || ''), (r[1] || [])[0]);
  check('a converted position joins the P&L total', /\+\$25\.00/.test(h[0]), h[0]);
  check('a converted position joins the risk total', /−\$17\.50/.test(h[1]), h[1]);
  check('no page errors through the FX path', errs.length === 0, errs.join(' | '));
  await page.context().close();
}

// IG writes the rate it used into the market name; that reference has to survive the import.
async function igReferenceRates(browser) {
  state = { orders: [], positions: [{ dealId: 'S', market: 'Singapore Blue Chip', direction: 'BUY', size: 2,
    level: 300, bid: 310, offer: 311, stopLevel: 295, contractSize: 1, currency: 'SGD' }] };
  const { page } = await openPage(browser);
  await page.evaluate(() => {
    document.querySelector('[data-act="import"]').click();
    document.querySelector('#paste').value = 'Date,Market name,Profit/Loss,Currency\n'
      + '2024-03-01,"Spot Gold converted at 0.7889",120.50,USD\n2024-03-02,"US 500",60,USD\n';
    document.querySelector('[data-act="parse"]').click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-act="commit"]').click());
  await page.waitForTimeout(1600);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades.map(t => t.rawInstrument || null));
  check('the converted market name is kept', stored.some(x => x && /converted at/.test(x)), JSON.stringify(stored));
  check('an ordinary market name is not duplicated', stored.some(x => x === null), JSON.stringify(stored));
  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(400);
  const ui = await page.evaluate(() => document.querySelector('#s-fx').innerText.replace(/\s+/g, ' '));
  check("IG's own past rate is offered as a reference", /0\.7889/.test(ui), ui.slice(0, 120));
  await page.context().close();
}

// The candle chart: it is read along the time axis, so time has to be zoomable, and it must not
// swallow the page scroll on the way past.
async function candleChart(browser, viewport, touch) {
  const label = touch ? 'phone' : 'desktop';
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid: 5062, offer: 5063, stopLevel: 4980,
    limitLevel: 5090, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser, viewport, touch);
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2200);
  const win = () => page.evaluate(() => { const c = window.Chart && Chart.getChart(document.querySelector('#c-pos'));
    if (!c) return null;
    const slot = (c.scales.x.right - c.scales.x.left) / Math.max(1, c.scales.x.max - c.scales.x.min + 1);
    const real = c.data.datasets[0].data.filter(v => v != null).length;
    return { bars: c.scales.x.max - c.scales.x.min + 1, min: c.scales.x.min, max: c.scales.x.max,
             total: real, future: c.data.labels.length - real,
             ySpan: +(c.scales.y.max - c.scales.y.min).toFixed(2), bodyPx: +(slot * 0.62 * 0.9).toFixed(2) }; });

  const a = await win();
  check(`${label}: the chart opens`, !!a, JSON.stringify(a));
  if (!a) { await page.context().close(); return; }
  // a candle has to be wide enough to read on whatever screen this is
  check(`${label}: candle bodies are legible`, a.bodyPx >= 3, `${a.bodyPx}px body`);
  check(`${label}: the window is a subset of the data`, a.bars < a.total, `${a.bars} of ${a.total}`);
  check(`${label}: there is room to scroll past the last candle`, a.future > 0, `${a.future} empty slots`);

  const box = await (await page.$('#c-pos')).boundingBox();
  if (!touch) {
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.mouse.wheel(0, -300); await page.waitForTimeout(350);
    const z = await win();
    check('desktop: the wheel zooms time', z.bars < a.bars, `${a.bars} -> ${z.bars}`);
    const area = await page.evaluate(() => { const a = Chart.getChart(document.querySelector('#c-pos')).chartArea;
      return { right: a.right, top: a.top, bottom: a.bottom }; });
    await page.mouse.move(box.x + area.right + 18, box.y + (area.top + area.bottom) / 2);
    await page.mouse.wheel(0, -240); await page.waitForTimeout(350);
    const sy = await win();
    check('desktop: the wheel over the price scale zooms price, not time', sy.bars === z.bars && sy.ySpan < z.ySpan, JSON.stringify(sy));
    check('desktop: the price scale shows a resize cursor', (await page.evaluate(() => document.querySelector('#c-pos').style.cursor)) === 'ns-resize');
    // a gentle notch should not throw the window across the chart
    const before = await win();
    await page.mouse.move(box.x + box.width * 0.5, box.y + (area.top + area.bottom) / 2);
    await page.mouse.wheel(0, -120); await page.waitForTimeout(300);
    const step = before.bars - (await win()).bars;
    check('desktop: one notch is a small step', step > 0 && step <= before.bars * 0.15, `${step} of ${before.bars} bars`);
    // and you can scroll on past the last candle
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * 0.5 - i * 22, box.y + (area.top + area.bottom) / 2);
    await page.mouse.up(); await page.waitForTimeout(350);
    check('desktop: the chart scrolls past the last candle', (await win()).max > (await win()).total - 1,
      `max ${(await win()).max}, last candle ${(await win()).total - 1}`);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(350);
    check('desktop: dragging pans time', (await win()).min < sy.min, `${sy.min} -> ${(await win()).min}`);
    await page.evaluate(() => document.querySelector('[data-zoom="fit"]').click()); await page.waitForTimeout(350);
    check('desktop: Fit restores the default window', (await win()).bars === a.bars, JSON.stringify(await win()));
    await page.evaluate(() => document.querySelector('[data-zoom="all"]').click()); await page.waitForTimeout(350);
    const all = await win();
    check('desktop: All shows every candle', all.bars >= all.total, `${all.bars} of ${all.total}`);
    // fully zoomed out, the wheel belongs to the page again
    await page.evaluate(() => { window.__pd = null;
      document.querySelector('#c-pos').addEventListener('wheel', e => { window.__pd = e.defaultPrevented; }, { passive: true, once: true }); });
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.wheel(0, 250); await page.waitForTimeout(300);
    check('desktop: the chart stops eating scroll at full zoom-out', (await page.evaluate(() => window.__pd)) === false);
  } else {
    check('phone: vertical swipes are left to the page', 
      (await page.evaluate(() => getComputedStyle(document.querySelector('#c-pos')).touchAction)) === 'pan-y');
    const hint = await page.evaluate(() => document.querySelector('.chart-hint')?.innerText || '');
    check('phone: the hint does not tell a finger to scroll-zoom', !/scroll/i.test(hint), hint);
    check('phone: there is future room to scroll into', a.future > 0, `${a.future} slots`);
    await page.evaluate(bx => { const cv = document.querySelector('#c-pos');
      const mk = (t, x, y, id = 1) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true }));
      mk('pointerdown', bx.x + bx.width * 0.7, bx.y + bx.height * 0.5);
      for (let i = 1; i <= 10; i++) mk('pointermove', bx.x + bx.width * 0.7 + i * 12, bx.y + bx.height * 0.5);
      mk('pointerup', bx.x + bx.width * 0.7 + 120, bx.y + bx.height * 0.5);
    }, box);
    await page.waitForTimeout(350);
    check('phone: a horizontal drag pans time', (await win()).min < a.min, `${a.min} -> ${(await win()).min}`);
    const b2 = await win();
    await page.evaluate(bx => { const cv = document.querySelector('#c-pos');
      const mk = (t, x, y, id) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
      mk('pointerdown', bx.x + bx.width * 0.4, bx.y + bx.height * 0.5, 1);
      mk('pointerdown', bx.x + bx.width * 0.6, bx.y + bx.height * 0.5, 2);
      for (let i = 1; i <= 8; i++) { mk('pointermove', bx.x + bx.width * 0.4 - i * 8, bx.y + bx.height * 0.5, 1); mk('pointermove', bx.x + bx.width * 0.6 + i * 8, bx.y + bx.height * 0.5, 2); }
      mk('pointerup', bx.x, bx.y + bx.height * 0.5, 1); mk('pointerup', bx.x + bx.width, bx.y + bx.height * 0.5, 2);
    }, box);
    await page.waitForTimeout(350);
    check('phone: pinching zooms time', (await win()).bars < b2.bars, `${b2.bars} -> ${(await win()).bars}`);
    await page.evaluate(bx => document.querySelector('#c-pos').dispatchEvent(new PointerEvent('pointerdown',
      { pointerId: 9, pointerType: 'touch', clientX: bx.x + bx.width * 0.3, clientY: bx.y + bx.height * 0.5, bubbles: true, cancelable: true })), box);
    await page.waitForTimeout(300);
    check('phone: a tap reads out that candle', /O /.test(await page.evaluate(() => document.querySelector('#ohlc')?.innerText || '')));
  }
  check(`${label}: no page errors driving the chart`, errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// IG only publishes a candle once its interval closes, so the bar in progress is built from the
// position feed. And the TradingView panel is third-party code on a page holding two tokens.
async function liveCandleAndTv(browser) {
  const px = (bid, offer) => { state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP',
    market: 'US 500', direction: 'BUY', size: 2, level: 5000, bid, offer, stopLevel: 4980,
    limitLevel: 5090, contractSize: 1, currency: 'USD' }] }; };
  px(5160, 5161);
  const { page, errs } = await openPage(browser);
  const external = [];
  page.on('request', r => { if (!r.url().startsWith(`http://localhost:${PORT}`)) external.push(r.url()); });
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2400);
  const bar = () => page.evaluate(() => {
    const c = window.Chart && Chart.getChart(document.querySelector('#c-pos'));
    if (!c) return null;
    const body = c.data.datasets[1].data.filter(v => v != null);
    return { bars: body.length, last: body[body.length - 1],
             readout: ((document.querySelector('#ohlc') || {}).innerText || '').replace(/\n/g, ' ') };
  });

  const a = await bar();
  check('a bar is forming past the last published candle', !!a && a.bars === 151, a && `${a.bars} bars`);
  px(5170, 5171); await page.waitForTimeout(3200);
  const b = await bar();
  check('the forming bar follows price up', b.last[1] > a.last[1], `${JSON.stringify(a.last)} -> ${JSON.stringify(b.last)}`);
  px(5140, 5141); await page.waitForTimeout(3200);
  const c = await bar();
  check('its high holds when price falls back', /H 5170/.test(c.readout), c.readout.slice(0, 64));
  check('its low tracks the fall', /L 5140/.test(c.readout), c.readout.slice(0, 64));
  check('no extra bar is appended per tick', c.bars === 151, `${c.bars} bars`);

  check('nothing third-party loads before opting in', external.length === 0, external.slice(0, 2).join(' '));
  check('the TradingView panel is empty by default',
    await page.evaluate(() => document.querySelector('#tvpanel').innerHTML === ''));
  await page.evaluate(() => document.querySelector('[data-tv]')?.click());
  await page.waitForTimeout(900);
  const f = await page.evaluate(() => { const i = document.querySelector('#tvpanel iframe');
    return i ? { src: i.getAttribute('src'), sandbox: i.getAttribute('sandbox') } : null; });
  check('it renders a TradingView frame', !!f && /tradingview\.com/.test(f.src), f && f.src);
  check('the frame is sandboxed', !!f && /allow-scripts/.test(f.sandbox || ''), f && f.sandbox);
  check('the symbol is guessed from the market',
    (await page.evaluate(() => document.querySelector('#tv-sym')?.value)) === 'OANDA:SPX500USD');
  const src1 = f && f.src;
  await page.waitForTimeout(4500);
  check('the frame survives a poll without reloading',
    (await page.evaluate(() => document.querySelector('#tvpanel iframe')?.getAttribute('src'))) === src1);
  await page.fill('#tv-sym', 'NASDAQ:AAPL');
  await page.evaluate(() => document.querySelector('[data-tvset]')?.click());
  await page.waitForTimeout(800);
  check('a typed symbol is used and remembered',
    /NASDAQ%3AAAPL/.test(await page.evaluate(() => document.querySelector('#tvpanel iframe')?.getAttribute('src')) || '')
    && !!(await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.tv.symbols['IX.D.SPTRD.IFE.IP'])));
  await page.evaluate(() => document.querySelector('[data-res="HOUR"]')?.click());
  await page.waitForTimeout(1600);
  check('the frame follows the chart timeframe',
    /interval=60/.test(await page.evaluate(() => document.querySelector('#tvpanel iframe')?.getAttribute('src')) || ''));
  await page.evaluate(() => document.querySelector('[data-chartclose]')?.click());
  await page.waitForTimeout(600);
  check('closing the chart clears the frame',
    await page.evaluate(() => document.querySelector('#tvpanel').innerHTML === ''));
  check('no page errors through the live bar and TV panel', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// ---------------------------------------------------------------------- main
(async () => {
  if (!fs.existsSync(FILE)) { console.error(`not found: ${FILE}`); process.exit(2); }
  const srv = await serve(path.dirname(FILE));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  console.log(`live-testing ${FILE}\n`);
  try {
    for (const [label, fn] of [['rendering', rendering], ['trailed stops', trailedStops],
      ['bad worker data', badData], ['closing a position', closing],
      ['foreign currency', foreignCurrency], ['IG reference rates', igReferenceRates],
      ['candle chart (desktop)', b => candleChart(b, { width: 1400, height: 900 }, false)],
      ['candle chart (phone)', b => candleChart(b, { width: 390, height: 844 }, true)],
      ['live bar + TradingView', liveCandleAndTv]]) {
      process.stdout.write(`  ${label}… `);
      const before = results.length;
      try { await fn(browser); } catch (e) { check(`${label} suite crashed`, false, String(e.message || e).slice(0, 140)); }
      const run = results.slice(before);
      console.log(`${run.filter(x => x.pass).length}/${run.length}`);
    }
  } finally { await browser.close(); srv.close(); }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('\nfailures:'); for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`); }
  process.exit(failed.length ? 1 : 0);
})();
