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
    if (p === '/sync') { calls.push({ p });
      const body = { account: 'IG', transactions: state.syncTx || [], activity: [] };
      return state.syncDelay ? setTimeout(() => json(200, body), state.syncDelay) : json(200, body); }
    if (p === '/liquid') {
      calls.push({ p, auth: req.headers.authorization || null });
      if (state.lqStatus && state.lqStatus !== 200) return json(state.lqStatus, { error: 'liquid upstream is down' });
      const send = (c, o) => state.lqDelay ? setTimeout(() => json(c, o), state.lqDelay) : json(c, o);
      return send(200, {
        account: { equity: '82.62', margin_used: '81.94', available_balance: '0.68', username: 'busayen' },
        positions: [{ symbol: 'xyz:CL-PERP', side: 'long', size: '14.183', entryPx: '94.479',
          markPx: String(state.lqMark || 95.465), leverage: '20', leverageType: 'isolated',
          unrealizedPnl: String(state.lqPnl == null ? 14.2 : state.lqPnl), liquidationPx: '92.0035',
          marginUsed: '81.94', returnOnEquity: '0.212', tp: '99.203', sl: '94.637', displayName: 'WTIOIL' }],
        rows: (state.lqRows || []),
      });
    }
    if (p === '/markets') {
      const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').toLowerCase();
      calls.push({ p, q });
      if (state.marketsMissing) { res.writeHead(404); return res.end(); }
      const all = [
        { epic: 'IX.D.DOW.IFE.IP', name: 'Wall Street Cash', type: 'INDICES', expiry: 'DFB', status: 'TRADEABLE' },
        { epic: 'CS.D.GBPJPY.CFD.IP', name: 'GBP/JPY', type: 'CURRENCIES', expiry: '-', status: 'TRADEABLE' },
        // deliberately absent from the built-in book, so only a live search can reach it
        { epic: 'IX.D.LIVEONLY.IFE.IP', name: 'Live Only Market', type: 'INDICES', expiry: 'SEP-26', status: 'TRADEABLE' },
      ];
      return json(200, { markets: all.filter(m => `${m.name} ${m.epic}`.toLowerCase().includes(q)) });
    }
    if (p === '/candles') { calls.push({ p });
      const out = []; let px = 5000, seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648, seed / 2147483648);
      // end the history at the last closed five-minute boundary, so a bar is genuinely forming
      const stepMs = 3e5;
      // state.partialBar mirrors what IG really returns: the newest bar is the interval still
      // open, timestamped with its start.
      const t0 = Math.floor(Date.now() / stepMs) * stepMs - (state.partialBar ? 149 : 150) * stepMs;
      for (let i = 0; i < 150; i++) {
        const o = px, c = o + (rnd() - 0.47) * 14;
        out.push({ t: new Date(t0 + i * stepMs).toISOString().slice(0, 19), o: +o.toFixed(1),
          h: +(Math.max(o, c) + rnd() * 6).toFixed(1), l: +(Math.min(o, c) - rnd() * 6).toFixed(1),
          c: +c.toFixed(1), v: Math.round(500 + rnd() * 4000) });
        px = c;
      }
      return json(200, { candles: out, allowance: { remaining: 9400, total: 10000 }, cached: false }); }
    if (p === '/order' && req.method === 'POST') {
      let body = ''; req.on('data', c => body += c);
      return req.on('end', () => { calls.push({ p, body, auth: req.headers.authorization || null });
        return state.orderStatus && state.orderStatus !== 200 ? json(state.orderStatus, state.orderBody || { error: 'order failed' })
          : json(200, state.orderBody || { dealStatus: 'ACCEPTED', dealId: 'NEW1', level: 5100 }); }); }
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
  const win = () => page.evaluate(() => {
    const c = window.Chart && Chart.getChart(document.querySelector('#c-pos'));
    const st = window.__chart && window.__chart();
    if (!c || !st || !st.x) return null;
    const sx = c.scales.x;
    const slot = Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0));
    return { bars: +(sx.max - sx.min + 1).toFixed(3), min: sx.min, max: sx.max,
             total: st.rows.length, future: +(sx.max - (st.rows.length - 1)).toFixed(3),
             ySpan: +(c.scales.y.max - c.scales.y.min).toFixed(2),
             bodyPx: +Math.max(1, Math.min(slot - 1, slot * 0.78, 26)).toFixed(2) };
  });

  const a = await win();
  check(`${label}: the chart opens`, !!a, JSON.stringify(a));
  if (!a) { await page.context().close(); return; }
  // a candle has to be wide enough to read on whatever screen this is
  check(`${label}: candle bodies are legible`, a.bodyPx >= 6, `${a.bodyPx}px body`);
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
    check('desktop: the wheel over the price scale zooms price, not time', Math.abs(sy.bars - z.bars) < 0.01 && sy.ySpan < z.ySpan, JSON.stringify(sy));
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
    const prePan = await win();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(500);
    check('desktop: dragging pans time', (await win()).min < prePan.min, `${prePan.min} -> ${(await win()).min}`);
    await page.evaluate(() => document.querySelector('[data-zoom="fit"]').click()); await page.waitForTimeout(350);
    check('desktop: Fit restores the default window', Math.abs((await win()).bars - a.bars) < 0.01, JSON.stringify(await win()));
    await page.evaluate(() => document.querySelector('[data-zoom="all"]').click()); await page.waitForTimeout(350);
    const all = await win();
    check('desktop: All shows every candle', all.bars >= all.total, `${all.bars} of ${all.total}`);
    // Fully zoomed out, the wheel belongs to the page again. Asserted on defaultPrevented rather
    // than on the page actually moving: whether there is scroll room left depends on layout
    // height, which made this flaky.
    // Dispatched rather than driven by the mouse: after a sequence of drags the canvas can sit
    // outside the viewport, and a pointer aimed off-screen produces no wheel event at all, which
    // made this flaky. What is under test is the handler's decision to swallow the gesture or not,
    // and a synthetic cancelable wheel exercises exactly that.
    const swallowed = async () => page.evaluate(() => {
      const cv = document.querySelector('#c-pos');
      const ch = Chart.getChart(cv), a = ch.chartArea, r = cv.getBoundingClientRect();
      const ev = new WheelEvent('wheel', { deltaY: 250, cancelable: true, bubbles: true,
        clientX: r.left + (a.left + a.right) / 2, clientY: r.top + (a.top + a.bottom) / 2 });
      cv.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    check('desktop: the chart stops eating scroll at full zoom-out', (await swallowed()) === false);
    // A sideways swipe pans time and is never handed to the page: horizontal page scroll over a
    // chart is always an accident, and at the pan limit it used to take the whole screen with it.
    const sideways = async () => page.evaluate(() => {
      const cv = document.querySelector('#c-pos');
      const ch = Chart.getChart(cv), a = ch.chartArea, r = cv.getBoundingClientRect();
      const before = window.__chart().x.min;
      const ev = new WheelEvent('wheel', { deltaX: 180, deltaY: 0, cancelable: true, bubbles: true,
        clientX: r.left + (a.left + a.right) / 2, clientY: r.top + (a.top + a.bottom) / 2 });
      cv.dispatchEvent(ev);
      return { swallowed: ev.defaultPrevented, moved: window.__chart().x.min - before };
    });
    const sw = await sideways();
    check('desktop: a sideways swipe pans instead of scrolling the page', sw.swallowed === true, JSON.stringify(sw));
    check('desktop: and it actually moves the window', sw.moved > 0, `min moved ${sw.moved}`);
    await page.evaluate(() => document.querySelector('[data-zoom="fit"]')?.click());
    await page.waitForTimeout(350);
    check('desktop: but it does take the wheel while there is room to zoom', (await swallowed()) === true);
  } else {
    check('phone: vertical swipes are left to the page', 
      (await page.evaluate(() => getComputedStyle(document.querySelector('#c-pos')).touchAction)) === 'pan-y');
    const hint = await page.evaluate(() => document.querySelector('.chart-hint')?.innerText || '');
    check('phone: the hint does not tell a finger to scroll-zoom', !/scroll/i.test(hint), hint);
    check('phone: there is future room to scroll into', a.future > 0, `${a.future} slots`);
    // aimed at the plot, not the canvas: the price gutter is not draggable chart
    await page.evaluate(bx => { const cv = document.querySelector('#c-pos');
      const a = Chart.getChart(cv).chartArea;
      const x0 = bx.x + a.left + (a.right - a.left) * 0.5, y0 = bx.y + (a.top + a.bottom) / 2;
      const mk = (t, x, y, id = 1) => cv.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true }));
      mk('pointerdown', x0, y0);
      for (let i = 1; i <= 10; i++) mk('pointermove', x0 + i * 12, y0);
      mk('pointerup', x0 + 120, y0);
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
    const st = window.__chart && window.__chart();
    if (!st || !st.rows.length) return null;
    const r = st.rows[st.rows.length - 1];
    return { bars: st.rows.length, last: [Math.min(r.o, r.c), Math.max(r.o, r.c)],
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
  // The drawing toolbar is TradingView's own, toggled through the frame URL. On a desktop-width
  // viewport it starts on; the toggle must flip the flag and be remembered.
  const tvSrc = () => page.evaluate(() => document.querySelector('#tvpanel iframe')?.getAttribute('src') || '');
  check('the drawing toolbar is on at desktop width', /hide_side_toolbar=0/.test(await tvSrc()), await tvSrc());
  await page.evaluate(() => document.querySelector('[data-tvdraw]')?.click());
  await page.waitForTimeout(700);
  check('the Draw toggle hides the drawing toolbar', /hide_side_toolbar=1/.test(await tvSrc()), await tvSrc());
  check('the choice is persisted',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.tv.draw)) === false);
  await page.evaluate(() => document.querySelector('[data-tvdraw]')?.click());
  await page.waitForTimeout(700);
  check('and it toggles back on', /hide_side_toolbar=0/.test(await tvSrc()), await tvSrc());

  await page.evaluate(() => document.querySelector('[data-chartclose]')?.click());
  await page.waitForTimeout(600);
  check('closing the chart clears the frame',
    await page.evaluate(() => document.querySelector('#tvpanel').innerHTML === ''));
  check('no page errors through the live bar and TV panel', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// App-side stops send a real close order at a price this tab watches for. Every failure mode here
// is money, so each one is pinned down: it must not fire early, must fire exactly once, must not
// retry into a rejection, and must keep watching when the tab is hidden.
async function appSideStops(browser) {
  const at = (bid, offer, extra) => { state = { orders: [], ...(extra || {}), positions: [{ dealId: 'D1',
    epic: 'E', market: 'US 500', direction: 'BUY', size: 2, level: 5000, bid, offer,
    stopLevel: 4900, contractSize: 1, currency: 'USD' }] }; };
  const closes = () => calls.filter(c => c.p === '/close');
  const stops = page => page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.softStops || {});
  const arm = async (page, price) => {
    await page.evaluate(() => document.querySelector('[data-softstop]')?.click());
    await page.waitForTimeout(400);
    await page.fill('#ss-price', String(price));
    await page.evaluate(() => document.querySelector('[data-arm]')?.click());
    await page.waitForTimeout(700);
  };
  const hide = (page, h) => page.evaluate(v => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);

  at(5100, 5101);
  const { page, errs } = await openPage(browser);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.closeToken = 'CLOSETOK'; localStorage.setItem('ledger:v4', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);

  await page.evaluate(() => document.querySelector('[data-softstop]')?.click());
  await page.waitForTimeout(400);
  check('the dialog says it only works while the tab is open',
    /only works while this tab is open/i.test(await page.evaluate(() => document.querySelector('.overlay.open .modal')?.innerText || '')));
  await page.fill('#ss-price', '5200');                    // above a long's price: already through
  await page.evaluate(() => document.querySelector('[data-arm]')?.click());
  await page.waitForTimeout(300);
  check('a level already through the price is refused',
    /already through/i.test(await page.evaluate(() => document.querySelector('#ss-err')?.textContent || '')));
  await page.fill('#ss-price', '5050');
  check('it shows the distance and what is at risk',
    /50\.00 away/.test(await page.evaluate(() => document.querySelector('#ss-dist')?.textContent || '')));
  calls = [];
  await page.evaluate(() => document.querySelector('[data-arm]')?.click());
  await page.waitForTimeout(700);
  const armed = await stops(page);
  check('arming stores the level and an idempotency key', armed.D1 && armed.D1.price === 5050 && !!armed.D1.key, JSON.stringify(armed.D1 || null));
  check('the open section warns that it needs the tab open',
    /only work while this tab is open/i.test(await page.evaluate(() => document.querySelector('#open')?.innerText || '')));

  at(5060, 5061); await page.waitForTimeout(3000);
  check('it does not fire before the level', closes().length === 0, `${closes().length} sends`);
  at(5045, 5046); await page.waitForTimeout(4000);
  check('it fires once through the level', closes().length === 1, `${closes().length} sends`);
  const body = closes()[0] ? JSON.parse(closes()[0].body) : {};
  check('the close carries the key minted when it was armed', body.idempotencyKey === armed.D1.key, body.idempotencyKey);
  check('the stop is cleared once IG confirms', Object.keys(await stops(page)).length === 0);
  await page.waitForTimeout(3500);
  check('it does not send again after firing', closes().length === 1, `${closes().length} sends`);

  // a rejection must be reported, not retried in a loop
  at(5100, 5101, { closeBody: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } });
  await page.waitForTimeout(2500);
  await arm(page, 5050);
  calls = [];
  at(5040, 5041, { closeBody: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } });
  await page.waitForTimeout(4000);
  check('a rejection is sent once, not retried', closes().length === 1, `${closes().length} sends`);
  check('a rejection is surfaced in the open section',
    /MARKET_CLOSED/.test(await page.evaluate(() => document.querySelector('#open')?.innerText || '')));
  await page.waitForTimeout(3500);
  check('a rejected stop stays quiet afterwards', closes().length === 1, `${closes().length} sends`);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.softStops = {}; localStorage.setItem('ledger:v4', JSON.stringify(s)); });

  // hidden tab: no stop means no polling, an armed stop means keep watching
  at(5100, 5101);
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);
  calls = []; await hide(page, true); await page.waitForTimeout(5000);
  check('a hidden tab stops polling when nothing is armed',
    calls.filter(c => c.p === '/positions').length === 0, `${calls.filter(c => c.p === '/positions').length} polls`);
  await hide(page, false); await page.waitForTimeout(1500);
  await arm(page, 5050);
  calls = []; await hide(page, true); await page.waitForTimeout(5500);
  check('a hidden tab keeps polling while a stop is armed',
    calls.filter(c => c.p === '/positions').length > 0, `${calls.filter(c => c.p === '/positions').length} polls`);
  calls = []; at(5040, 5041); await page.waitForTimeout(5000);
  check('an armed stop still fires while the tab is hidden', closes().length === 1, `${closes().length} sends`);
  check('no page errors through the stop paths', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// A trailing level is derived from the best price seen, so it must ratchet one way only — and
// polling can only observe a high at or below the real one, which is why it runs looser than a
// broker's trail. What must not happen is it giving ground.
async function trailingStops(browser) {
  const at = (bid, offer, dir) => { state = { orders: [], positions: [{ dealId: 'D1', epic: 'E',
    market: 'US 500', direction: dir || 'BUY', size: 2, level: dir === 'SELL' ? 5200 : 5000,
    bid, offer, stopLevel: dir === 'SELL' ? 5300 : 4900, contractSize: 1, currency: 'USD' }] }; };
  const closes = () => calls.filter(c => c.p === '/close');
  const stop = page => page.evaluate(() => { const st = JSON.parse(localStorage.getItem('ledger:v4')).settings.softStops?.D1;
    return st && { price: st.price, anchor: st.trail && st.trail.anchor }; });
  const armTrail = async (page, by) => {
    await page.evaluate(() => document.querySelector('[data-softstop]')?.click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#ss-mode [data-mode="trail"]')?.click());
    await page.waitForTimeout(200);
    await page.fill('#ss-trailby', String(by));
    await page.waitForTimeout(150);
    const preview = await page.evaluate(() => document.querySelector('#ss-dist')?.textContent || '');
    await page.evaluate(() => document.querySelector('[data-arm]')?.click());
    await page.waitForTimeout(700);
    return preview;
  };

  at(5100, 5101);
  const { page, errs } = await openPage(browser);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.closeToken = 'CLOSETOK'; localStorage.setItem('ledger:v4', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);

  const preview = await armTrail(page, 20);
  check('the preview says which way a long trail can move', /only move up/.test(preview), preview.slice(0, 90));
  const a0 = await stop(page);
  check('a long trail starts one distance below the price', a0 && a0.price === 5080, JSON.stringify(a0));
  calls = [];
  at(5180, 5181); await page.waitForTimeout(3200);
  const a1 = await stop(page);
  check('it follows the price up', a1.price === 5160 && a1.anchor === 5180, JSON.stringify(a1));
  at(5165, 5166); await page.waitForTimeout(3200);
  const a2 = await stop(page);
  check('it does not give ground when price falls back', a2.price === 5160 && a2.anchor === 5180, JSON.stringify(a2));
  check('and does not fire above the trailed level', closes().length === 0, `${closes().length} sends`);
  at(5158, 5159); await page.waitForTimeout(4000);
  check('it fires once through the trailed level', closes().length === 1, `${closes().length} sends`);

  // the short side has to mirror it exactly
  at(5100, 5101, 'SELL');
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1600);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);
  const p2 = await armTrail(page, 20);
  check('the preview says which way a short trail can move', /only move down/.test(p2), p2.slice(0, 90));
  const b0 = await stop(page);
  check('a short trail starts one distance above the price', b0 && b0.price === 5121, JSON.stringify(b0));
  calls = [];
  at(5060, 5061, 'SELL'); await page.waitForTimeout(3200);
  const b1 = await stop(page);
  check('it follows the price down', b1.price === 5081 && b1.anchor === 5061, JSON.stringify(b1));
  at(5075, 5076, 'SELL'); await page.waitForTimeout(3200);
  check('it holds when a short bounces back', (await stop(page)).price === 5081, JSON.stringify(await stop(page)));
  check('and does not fire below the trailed level', closes().length === 0, `${closes().length} sends`);
  at(5082, 5083, 'SELL'); await page.waitForTimeout(4000);
  check('it fires once through the short trailed level', closes().length === 1, `${closes().length} sends`);
  check('no page errors through the trailing paths', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Opening a position is the only thing here that can create exposure, so it gets its own token and
// the same never-claim-success-early handling as a close — plus one difference that matters: an
// unconfirmed OPEN must not be retryable, because a second attempt doubles the position.
async function placingOrders(browser) {
  const orders = () => calls.filter(c => c.p === '/order');
  const fill = async page => {
    await page.evaluate(() => document.querySelector('[data-neworder]')?.click());
    await page.waitForTimeout(400);
    await page.fill('#or-epic', 'IX.D.SPTRD.IFE.IP');
    await page.fill('#or-size', '2');
    await page.waitForTimeout(250);
  };
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid: 5100, offer: 5101, stopLevel: 4900,
    contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.orderToken = 'ORDTOK'; localStorage.setItem('ledger:v4', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);

  check('there is a way to place an order', await page.evaluate(() => !!document.querySelector('[data-neworder]')));
  await page.evaluate(() => document.querySelector('[data-neworder]')?.click());
  await page.waitForTimeout(400);
  check('it cannot be sent before it is filled in', await page.evaluate(() => document.querySelector('[data-send]')?.disabled) === true);
  check('epics the account has traded are offered', await page.evaluate(() => {
    const i = document.querySelector('#or-epic');
    i.focus(); i.dispatchEvent(new Event('input', { bubbles: true }));
    return Array.from(document.querySelectorAll('#or-epiclist .epic-row'))
      .some(r => /IX\.D\.SPTRD\.IFE\.IP/.test(r.innerText));
  }));
  await page.fill('#or-epic', 'IX.D.SPTRD.IFE.IP');
  await page.fill('#or-size', '2');
  await page.waitForTimeout(300);
  check('the summary reads the order back', /Buy 2 of US 500 at the market price/.test(
    await page.evaluate(() => document.querySelector('#or-summary')?.innerText || '')));
  await page.evaluate(() => document.querySelector('#or-type [data-type="LIMIT"]')?.click());
  await page.waitForTimeout(250);
  check('a limit order will not send without a level', await page.evaluate(() => document.querySelector('[data-send]')?.disabled) === true);
  await page.fill('#or-level', '5050'); await page.waitForTimeout(250);
  check('with a level, the summary says it is conditional', /only if it trades at/.test(
    await page.evaluate(() => document.querySelector('#or-summary')?.innerText || '')));
  await page.evaluate(() => document.querySelector('#or-type [data-type="MARKET"]')?.click());
  await page.waitForTimeout(250);

  calls = [];
  await page.evaluate(() => { const b = document.querySelector('[data-send]'); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(1800);
  check('three clicks place exactly one order', orders().length === 1, `${orders().length} sends`);
  const body = orders()[0] ? JSON.parse(orders()[0].body) : {};
  check('the order says what it is', body.epic === 'IX.D.SPTRD.IFE.IP' && body.direction === 'BUY' && body.size === 2 && body.orderType === 'MARKET', JSON.stringify(body));
  check('it carries an idempotency key', !!body.idempotencyKey);
  check('it uses the order token, not the close token', orders()[0] && orders()[0].auth === 'Bearer ORDTOK', orders()[0] && orders()[0].auth);
  check('success is only claimed on IG confirming', /IG confirmed/.test(
    await page.evaluate(() => document.querySelector('#toast')?.textContent || '')));

  // a rejection changed nothing, so retrying is fine
  state = { ...state, orderBody: { dealStatus: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' } };
  await page.waitForTimeout(500);
  await fill(page); calls = [];
  await page.evaluate(() => document.querySelector('[data-send]')?.click());
  await page.waitForTimeout(1400);
  check('a rejected order is reported and can be retried', await page.evaluate(() =>
    /rejected/i.test(document.querySelector('#or-err')?.textContent || '') && !document.querySelector('[data-send]')?.disabled));

  // an unconfirmed OPEN must not be retryable — this is the one that differs from a close
  state = { ...state, orderBody: { dealStatus: 'UNCONFIRMED', reason: 'no confirmation' } };
  await page.evaluate(() => document.querySelector('[data-send]')?.click());
  await page.waitForTimeout(1400);
  check('an unconfirmed order blocks a retry', await page.evaluate(() => !!document.querySelector('[data-send]')?.disabled));
  await page.evaluate(() => document.querySelector('[data-x]')?.click());
  await page.waitForTimeout(300);

  // and nothing is sent without the token
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.orderToken = ''; localStorage.setItem('ledger:v4', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1100);
  await fill(page); calls = [];
  check('without a saved token it asks for one', await page.evaluate(() => !!document.querySelector('#or-tok')));
  await page.evaluate(() => document.querySelector('[data-send]')?.click());
  await page.waitForTimeout(800);
  check('and sends nothing until it has one', orders().length === 0, `${orders().length} sends`);
  check('no page errors through the order paths', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Drawing tools live entirely in this app: anchored to time and price, saved per market, and
// painted over the candles. The trade planner is the one that costs money if it lies, so its
// geometry and its colours are both pinned down here.
async function drawingTools(browser) {
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid: 5062, offer: 5063, stopLevel: 4980,
    limitLevel: 5090, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser, { width: 1400, height: 900 });
  page.on('dialog', d => d.accept());
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2200);
  const st = () => page.evaluate(() => window.__chart && window.__chart());
  const box = async () => (await page.$('#c-pos')).boundingBox();
  const pick = t => page.evaluate(k => document.querySelector(`[data-tool="${k}"]`)?.click(), t);
  const saved = () => page.evaluate(() =>
    ((JSON.parse(localStorage.getItem('ledger:v4')).settings.draws || {})['IX.D.SPTRD.IFE.IP'] || []).length);

  check('the drawing toolbar is there',
    (await page.evaluate(() => document.querySelectorAll('[data-tool]').length)) === 8);
  const first = await st();
  check('it starts on the cursor', first.tool === 'cursor', first.tool);
  check('with nothing drawn', first.draws.length === 0);

  await pick('hline'); await page.waitForTimeout(250);
  check('picking a tool arms it', (await st()).tool === 'hline');
  await pick('hline'); await page.waitForTimeout(250);
  check('picking it again goes back to the cursor', (await st()).tool === 'cursor');

  await pick('hline'); await page.waitForTimeout(250);
  let b = await box();
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.45);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  const one = await st();
  check('a click with a tool up leaves a drawing', one.draws.length === 1 && one.draws[0].type === 'hline',
    JSON.stringify(one.draws.map(d => d.type)));
  check('and the tool hands back to the cursor', one.tool === 'cursor', one.tool);
  check('the drawing is saved against the market', (await saved()) === 1);

  // The planner: a long targets above the entry and stops below it, and a short is the mirror.
  await pick('long'); await page.waitForTimeout(250);
  b = await box();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.5, { steps: 6 });
  await page.mouse.up(); await page.waitForTimeout(300);
  const lg = (await st()).draws.find(d => d.type === 'pos' && d.side === 'long');
  check('the long tool plans a trade', !!lg, JSON.stringify((await st()).draws.map(d => d.type)));
  check('a long targets above entry and stops below',
    !!lg && lg.target > lg.a.p && lg.stop < lg.a.p, lg && `${lg.stop} < ${lg.a.p} < ${lg.target}`);

  await pick('short'); await page.waitForTimeout(250);
  b = await box();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.35, { steps: 6 });
  await page.mouse.up(); await page.waitForTimeout(300);
  const sh = (await st()).draws.find(d => d.type === 'pos' && d.side === 'short');
  check('the short tool mirrors it',
    !!sh && sh.target < sh.a.p && sh.stop > sh.a.p, sh && `${sh.target} < ${sh.a.p} < ${sh.stop}`);

  const pal = await page.evaluate(() => {
    const o = Chart.getChart(document.querySelector('#c-pos')).options.plugins.drawPaint;
    const cs = getComputedStyle(document.documentElement);
    return { up: o.upRgb, down: o.downRgb,
             pUp: cs.getPropertyValue('--profit-rgb').trim(), pDown: cs.getPropertyValue('--loss-rgb').trim() };
  });
  check('the planner paints with the profit and loss colours from Settings',
    pal.up === pal.pUp && pal.down === pal.pDown && !!pal.up, JSON.stringify(pal));

  // Anchored to a timestamp, so changing the resolution must not move or lose them.
  const kept = (await st()).draws.length;
  await page.evaluate(() => document.querySelector('[data-res="HOUR"]')?.click());
  await page.waitForTimeout(2000);
  check('drawings survive a timeframe change', (await st()).draws.length === kept,
    `${kept} -> ${(await st()).draws.length}`);
  await page.evaluate(() => document.querySelector('[data-res="MINUTE_5"]')?.click());
  await page.waitForTimeout(2000);

  const hl = (await st()).draws.find(d => d.type === 'hline');
  const py = await page.evaluate(v => Chart.getChart(document.querySelector('#c-pos')).scales.y.getPixelForValue(v), hl.a.p);
  b = await box();
  // clear of both position boxes, which sit in the middle and right of the plot
  const plotX = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#c-pos'));
    return c.chartArea.left + (c.chartArea.right - c.chartArea.left) * 0.05; });
  await page.mouse.click(b.x + plotX, b.y + py);
  await page.waitForTimeout(250);
  check('clicking a drawing selects it', (await st()).sel === hl.id, String((await st()).sel));
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  check('Delete removes the selected drawing', !(await st()).draws.some(d => d.id === hl.id));

  await page.evaluate(() => document.querySelector('[data-drawclear]')?.click());
  await page.waitForTimeout(350);
  check('Clear empties the market', (await st()).draws.length === 0 && (await saved()) === 0);

  // The old build could only ever scroll 40 slots past the last candle, whatever the zoom.
  await page.evaluate(() => document.querySelector('[data-zoom="fit"]')?.click());
  await page.waitForTimeout(300);
  b = await box();
  // Three drags that stay on the canvas: one long one runs the pointer off the left edge, where
  // no further move is delivered and the pan quietly stops short.
  for (let k = 0; k < 3; k++) {
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + b.width * 0.85 - i * (b.width * 0.055), b.y + b.height * 0.5);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(400);
  const far = await st();
  const future = far.x.max - (far.rows.length - 1);
  check('the future is no longer capped at a fixed number of slots', future > 60,
    `${future.toFixed(1)} slots past the last candle`);
  check('but the price itself is never scrolled off', far.x.min <= far.rows.length - 1,
    `min ${far.x.min.toFixed(1)}, last candle ${far.rows.length - 1}`);

  // A window that is not a whole number of bars is the whole point of the linear axis.
  check('the window is a fractional number of candles wide, not a whole one',
    (far.x.max - far.x.min) % 1 !== 0, String(far.x.max - far.x.min));

  check('no page errors driving the drawing tools', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Breakeven is the entry price, filled in for you. It is only reachable from in front: from
// behind it sits through the price and would fire the moment it armed, so it must be refused.
async function breakevenStop(browser) {
  const pos = (bid, offer) => ({ orders: [], positions: [{ dealId: 'D1', epic: 'E', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid, offer, stopLevel: 4900, contractSize: 1, currency: 'USD' }] });
  state = pos(5062, 5063);
  const { page, errs } = await openPage(browser);
  const open = async p => { await p.evaluate(() => document.querySelector('[data-softstop]')?.click()); await p.waitForTimeout(450); };
  const txt = (p, sel) => p.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);
  await open(page);
  check('the stop dialog offers Breakeven at the entry price', /5000/.test(await txt(page, '#ss-be')), await txt(page, '#ss-be'));
  await page.evaluate(() => document.querySelector('#ss-be').click());
  await page.waitForTimeout(250);
  check('Breakeven fills the entry price in',
    (await page.evaluate(() => document.querySelector('#ss-price').value)) === '5000');
  check('and it reads back how far away that is', /62/.test(await txt(page, '#ss-dist')), await txt(page, '#ss-dist'));
  await page.evaluate(() => document.querySelector('[data-arm]').click());
  await page.waitForTimeout(450);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).settings.softStops || {});
  check('arming it stores a stop at the entry price', !!st.D1 && st.D1.price === 5000, JSON.stringify(st.D1 || null));
  check('no page errors arming a breakeven stop', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();

  // the same button, with the position under water
  state = pos(4950, 4951);
  const { page: p2 } = await openPage(browser);
  await open(p2);
  await p2.evaluate(() => document.querySelector('#ss-be').click());
  await p2.waitForTimeout(250);
  check('below entry it warns Breakeven would fire immediately',
    /wrong side/i.test(await txt(p2, '#ss-dist')), await txt(p2, '#ss-dist'));
  await p2.evaluate(() => document.querySelector('[data-arm]').click());
  await p2.waitForTimeout(350);
  check('and arming it is refused', /through the price/i.test(await txt(p2, '#ss-err')), await txt(p2, '#ss-err'));
  check('nothing was armed', !(await p2.evaluate(() =>
    (JSON.parse(localStorage.getItem('ledger:v4')).settings.softStops || {}).D1)));
  await p2.context().close();
}

// The order ticket borrows the app's chart and points it at the order being composed, then hands
// it back. Both halves matter: a ticket with no chart is the old form, and a chart that never
// comes back loses the position the page was looking at.
async function ticketChart(browser) {
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid: 5062, offer: 5063, stopLevel: 4980,
    limitLevel: 5090, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser, { width: 1400, height: 900 });
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2200);
  const drawn = sel => page.evaluate(s => { const cv = document.querySelector(s + ' canvas');
    return !!(cv && window.Chart && Chart.getChart(cv)); }, sel);
  check('the page is charting the position first', await drawn('#chartpanel'));

  await page.evaluate(() => document.querySelector('[data-neworder]')?.click());
  await page.waitForTimeout(500);
  check('the ticket opens beside a chart slot',
    /Pick an instrument/.test(await page.evaluate(() => (document.querySelector('#or-chart') || {}).innerText || '')));
  const fill = async (sel, v) => { await page.fill(sel, v);
    await page.evaluate(s => document.querySelector(s).dispatchEvent(new Event('input', { bubbles: true })), sel); };
  await fill('#or-epic', 'IX.D.SPTRD.IFE.IP');
  await page.waitForTimeout(2600);
  check('naming an instrument loads its chart into the ticket', await drawn('#or-chart'));
  check('and the page chart is not left behind the modal', !(await drawn('#chartpanel')));

  await fill('#or-size', '1'); await fill('#or-stop', '25'); await fill('#or-limit', '75');
  await page.waitForTimeout(800);
  const lines = await page.evaluate(() => Chart.getChart(document.querySelector('#or-chart canvas'))
    .options.plugins.levelLines.lines.filter(l => l.value != null).map(l => `${l.label}:${l.value}`));
  check('the stop and target are drawn on the ticket chart',
    lines.some(l => l.startsWith('stop:')) && lines.some(l => l.startsWith('target:')), JSON.stringify(lines));
  const yr = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#or-chart canvas'));
    return { min: c.scales.y.min, max: c.scales.y.max }; });
  const stopV = Number((lines.find(l => l.startsWith('stop:')) || ':').split(':')[1]);
  check('and the price window frames them', stopV >= yr.min && stopV <= yr.max, `${stopV} in ${yr.min}..${yr.max}`);
  check('the ticket reads back the reward-to-risk',
    /3\.00 reward-to-risk/.test(await page.evaluate(() => (document.querySelector('#or-chart') || {}).innerText || '')));

  // selling flips which side the stop sits
  await page.evaluate(() => document.querySelector('#or-dir [data-dir="SELL"]').click());
  await page.waitForTimeout(700);
  const sell = await page.evaluate(() => Chart.getChart(document.querySelector('#or-chart canvas'))
    .options.plugins.levelLines.lines.filter(l => l.value != null && (l.label === 'stop' || l.label === 'target'))
    .map(l => `${l.label}:${l.value}`));
  const g = k => Number((sell.find(l => l.startsWith(k)) || ':').split(':')[1]);
  check('switching to sell puts the stop above and the target below', g('stop') > g('target'), JSON.stringify(sell));

  // The worker refuses a stop-less order by default, so the form says so before it is sent.
  await fill('#or-stop', '');
  await page.waitForTimeout(300);
  check('an order with no stop is called out before it is sent',
    /No stop/.test(await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || ''));
  await fill('#or-stop', '25');

  // a size with a stray digit or two is refused here, before the worker ever sees it
  await fill('#or-size', '1000000000');
  await page.waitForTimeout(300);
  check('an absurd size is refused',
    await page.evaluate(() => document.querySelector('[data-send]').disabled));
  check('and it says why', /typo/i.test(await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || '')));
  await fill('#or-size', '1');
  await page.waitForTimeout(300);
  check('a sane size is allowed again',
    !(await page.evaluate(() => document.querySelector('[data-send]').disabled)));

  // The instrument picker: search by market name, not by a code nobody remembers.
  await fill('#or-epic', 'dow mini');
  await page.waitForTimeout(350);
  const hits = await page.evaluate(() => Array.from(document.querySelectorAll('#or-epiclist .epic-row'))
    .map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  check('searching a market name finds its epic', hits.length === 1 && /IX\.D\.DOW\.IMF\.IP/.test(hits[0]), JSON.stringify(hits));
  check('and the words can be in any order',
    (await page.evaluate(() => { const i = document.querySelector('#or-epic');
      i.value = 'mini dow'; i.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelectorAll('#or-epiclist .epic-row').length; })) === 1);
  await page.evaluate(() => document.querySelector('#or-epiclist .epic-row').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForTimeout(2600);
  check('picking one fills the epic in', (await page.evaluate(() => document.querySelector('#or-epic').value)) === 'IX.D.DOW.IMF.IP');
  check('and names the market rather than the code in the summary',
    /Wall Street/i.test(await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || ''));
  check('epics this account has traded are listed first and marked',
    await page.evaluate(() => { const i = document.querySelector('#or-epic');
      i.value = 'SPTRD'; i.dispatchEvent(new Event('input', { bubbles: true }));
      const first = document.querySelector('#or-epiclist .epic-row');
      const group = document.querySelector('#or-epiclist .epic-group');
      return !!first && /traded/i.test(first.innerText) && /account/i.test(group.innerText); }));
  await fill('#or-epic', 'IX.D.SPTRD.IFE.IP');
  await page.waitForTimeout(2200);

  await page.evaluate(() => document.querySelector('.modal.ticket [data-x]').click());
  await page.waitForTimeout(700);
  check('closing the ticket hands the chart back to the page', await drawn('#chartpanel'));
  check('and the ticket is gone', !(await page.evaluate(() => !!document.querySelector('.modal.ticket'))));
  check('no page errors through the ticket', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// IG stamps a bar with the START of its interval and hands back the one still in progress, so its
// newest candle is normally the current bucket, not a closed one. That bar is bought once and
// never refetched, so if the chart defers to it the last candle is frozen mid-formation.
async function livePartialBar(browser) {
  state = { orders: [], partialBar: true, positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP',
    market: 'US 500', direction: 'BUY', size: 2, level: 5000, bid: 5160, offer: 5161,
    stopLevel: 4980, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2400);
  const bar = () => page.evaluate(() => {
    const st = window.__chart && window.__chart();
    if (!st || !st.rows.length) return null;
    const r = st.rows[st.rows.length - 1];
    return { bars: st.rows.length, t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, forming: !!r.forming };
  });
  const a = await bar();
  check('the newest bar is the interval still open', !!a && a.forming, JSON.stringify(a));
  check("it replaces IG's partial bar rather than following it", !!a && a.bars === 150, a && `${a.bars} bars`);
  // the mock's series is deterministic: IG's partial bar for this interval is o 5160.4 h 5169.3 l 5157.6
  check("it keeps IG's open for that interval", !!a && Math.abs(a.o - 5160.4) < 0.05, a && `o ${a.o}`);
  check("IG's high and low for the interval are not lost",
    !!a && a.h >= 5169.3 && a.l <= 5157.6, a && `h ${a.h} l ${a.l}`);
  check('and its close is the live price', !!a && Math.abs(a.c - 5160.5) < 0.01, a && `c ${a.c}`);

  state.positions[0].bid = 5175; state.positions[0].offer = 5176;
  await page.waitForTimeout(3200);
  const b = await bar();
  check('it follows the price up', !!b && b.c > a.c, `${a.c} -> ${b && b.c}`);
  check('its high moves with it', !!b && b.h >= 5175, b && `h ${b.h}`);
  check('and nothing is appended as it moves', !!b && b.bars === a.bars, `${a.bars} -> ${b && b.bars}`);

  state.positions[0].bid = 5140; state.positions[0].offer = 5141;
  await page.waitForTimeout(3200);
  const c = await bar();
  check('the high holds when price falls back', !!c && c.h >= 5175, c && `h ${c.h}`);
  check('the low tracks the fall', !!c && c.l <= 5141, c && `l ${c.l}`);
  check('and the open never drifts once set', !!c && c.o === a.o, `${a.o} -> ${c && c.o}`);
  check('no page errors over a partial bar', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// The averaging ladder opens positions on its own, which nothing else in this app does. Every
// check here is about it refusing to: not before its trigger, not twice in a tick, not past the
// money cap, not after a rejection, and not at all without the risk being acknowledged.
// Geometry under test: size 1 at 5000, stop 4900, so R = 100 points and unit = 1.
//   rung 1 at -0.2R = 4980, size 1.5, loses 1.5 x 80  = 120
//   rung 2 at -0.5R = 4950, size 2.25, loses 2.25 x 50 = 112.5
//   seed                                loses 1 x 100  = 100   -> 332.5 all in
async function averagingLadder(browser) {
  const pos = (bid, offer, extra) => ({ orders: [], orderBody: { dealStatus: 'ACCEPTED', dealId: 'NEW1' }, ...(extra || {}),
    positions: [{ dealId: 'D1', epic: 'E1', market: 'US 500', direction: 'BUY', size: 1, level: 5000,
      bid, offer, stopLevel: 4900, contractSize: 1, currency: 'USD', ...((extra || {}).pos || {}) }] });
  const openDlg = async pg => { await pg.evaluate(() => document.querySelector('[data-ladder]')?.click()); await pg.waitForTimeout(450); };
  const txt = (pg, sel) => pg.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);
  const led = pg => pg.evaluate(() => (JSON.parse(localStorage.getItem('ledger:v4')).settings.ladders || {}).D1 || null);
  const since = n => calls.slice(n).filter(c => c.p === '/order').map(c => JSON.parse(c.body));
  const armIt = async (pg, cap, shadow = false) => {
    await pg.fill('#ld-cap', String(cap));
    await pg.evaluate(sh => { document.querySelector('#ld-shadow').checked = sh;
      document.querySelector('#ld-ok').checked = true; }, shadow);
    const tok = await pg.$('#ld-tok');
    if (tok) await pg.fill('#ld-tok', 'ORDERTOK');
    await pg.evaluate(() => document.querySelector('[data-arm]').click());
    await pg.waitForTimeout(500);
  };

  state = pos(5010, 5011);
  const { page, errs } = await openPage(browser);
  await openDlg(page);
  check('a new ladder starts in shadow mode',
    await page.evaluate(() => document.querySelector('#ld-shadow').checked));
  const dlg = await txt(page, '#ld-modal');
  check('the dialog states what the finished ladder risks', /332\.5/.test(dlg), dlg.slice(0, 120));
  check('and contrasts it with the position on its own', /100/.test(dlg));
  check('it lists both rungs with their trigger prices', /4980/.test(dlg) && /4950/.test(dlg));
  check('and their scaled sizes', /1\.5/.test(dlg) && /2\.25/.test(dlg));

  await page.evaluate(() => { document.querySelector('#ld-cap').value = '400';
    document.querySelector('#ld-shadow').checked = false; });
  await page.evaluate(() => document.querySelector('[data-arm]').click());
  await page.waitForTimeout(300);
  check('going live will not arm until the risk is acknowledged',
    /confirm/i.test(await txt(page, '#ld-err')) && !(await led(page)), await txt(page, '#ld-err'));

  await armIt(page, 400);
  const armed = await led(page);
  check('arming stores the ladder', !!armed && armed.state === 'armed', JSON.stringify(armed && armed.state));
  check('with the cap that was typed', !!armed && armed.maxRisk === 400);
  check('and no rungs filled yet', !!armed && armed.rungs.length === 0);

  let n = calls.length;
  state.positions[0].bid = 4990; state.positions[0].offer = 4991;
  await page.waitForTimeout(3000);
  check('it does not add before its trigger', since(n).length === 0, JSON.stringify(since(n)));

  n = calls.length;
  state.positions[0].bid = 4978; state.positions[0].offer = 4979;
  await page.waitForTimeout(3200);
  const r1 = since(n);
  check('crossing -0.2R adds one rung', r1.length === 1, JSON.stringify(r1));
  check('scaled 1.5x off the seed', r1[0] && r1[0].size === 1.5, r1[0] && String(r1[0].size));
  check('in the same direction as the position', r1[0] && r1[0].direction === 'BUY');
  check('as a market order', r1[0] && r1[0].orderType === 'MARKET');
  check('carrying a broker stop aimed at the shared level',
    r1[0] && Math.abs(r1[0].stopDistance - 78) <= 2, r1[0] && `stopDistance ${r1[0].stopDistance}`);
  check('with an idempotency key fixed to that rung', r1[0] && /:r0$/.test(r1[0].idempotencyKey), r1[0] && r1[0].idempotencyKey);
  check('the ladder records the fill', ((await led(page)) || {}).rungs.length === 1);

  n = calls.length;
  await page.waitForTimeout(3000);
  check('and it does not add again at the same price', since(n).length === 0, JSON.stringify(since(n)));

  n = calls.length;
  state.positions[0].bid = 4948; state.positions[0].offer = 4949;
  await page.waitForTimeout(3200);
  const r2 = since(n);
  check('crossing -0.5R adds the last rung', r2.length === 1 && r2[0].size === 2.25, JSON.stringify(r2));
  const doneL = await led(page);
  check('the ladder is then finished', !!doneL && doneL.state === 'done', doneL && doneL.state);

  n = calls.length;
  state.positions[0].bid = 4910; state.positions[0].offer = 4911;
  await page.waitForTimeout(3000);
  check('a finished ladder adds nothing more', since(n).length === 0, JSON.stringify(since(n)));
  check('no page errors running a ladder', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();

  // The cap is the point of the whole feature: 100 + 120 = 220 is inside 250, 332.5 is not.
  state = pos(5010, 5011);
  const { page: p2 } = await openPage(browser);
  await openDlg(p2); await armIt(p2, 250);
  let m = calls.length;
  state.positions[0].bid = 4978; state.positions[0].offer = 4979;
  await p2.waitForTimeout(3200);
  check('a rung inside the cap goes on', since(m).length === 1, JSON.stringify(since(m)));
  m = calls.length;
  state.positions[0].bid = 4948; state.positions[0].offer = 4949;
  await p2.waitForTimeout(3400);
  check('the rung that would breach the cap does not', since(m).length === 0, JSON.stringify(since(m)));
  const capped = await led(p2);
  check('and the ladder stops there, saying so', !!capped && capped.state === 'capped', capped && capped.state);
  check('the note names the cap', !!capped && /cap/i.test(capped.note || ''), capped && capped.note);
  await p2.context().close();

  // One rung per tick, even when price gaps straight past both triggers.
  state = pos(5010, 5011);
  const { page: p3 } = await openPage(browser);
  await openDlg(p3); await armIt(p3, 400);
  let g = calls.length;
  state.positions[0].bid = 4930; state.positions[0].offer = 4931;
  await p3.waitForTimeout(2600);
  const gapped = since(g);
  // Both rungs are due, so both go on — one per tick, each exactly once. What protects you when
  // they fill 50 points from their triggers is the cap, which counts the real fills.
  check('a gap past both triggers fills each rung exactly once',
    gapped.length === 2 && new Set(gapped.map(o => o.idempotencyKey)).size === 2,
    JSON.stringify(gapped.map(o => o.idempotencyKey)));
  check('and each keeps its own scaled size',
    gapped.length === 2 && gapped[0].size === 1.5 && gapped[1].size === 2.25,
    JSON.stringify(gapped.map(o => o.size)));
  await p3.waitForTimeout(3200);
  check('and nothing is added after that', since(g).length === 2, `${since(g).length} orders`);
  await p3.context().close();

  // A rejected entry stops the ladder rather than retrying into a moving market.
  state = pos(5010, 5011, { orderBody: { dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' } });
  const { page: p4 } = await openPage(browser);
  await openDlg(p4); await armIt(p4, 400);
  let e = calls.length;
  state.positions[0].bid = 4978; state.positions[0].offer = 4979;
  await p4.waitForTimeout(3200);
  check('a rejected rung is not retried', since(e).length === 1, `${since(e).length} attempts`);
  await p4.waitForTimeout(3200);
  check('still not retried a tick later', since(e).length === 1, `${since(e).length} attempts`);
  const bad = await led(p4);
  check('and the ladder is left in an error state', !!bad && bad.state === 'error', bad && bad.state);
  check('naming what IG said', !!bad && /MARKET_CLOSED/.test(bad.note || ''), bad && bad.note);
  await p4.context().close();

  // No broker stop means no R to measure against and no shared level to put underneath.
  state = pos(5010, 5011, { pos: { stopLevel: null } });
  const { page: p5 } = await openPage(browser);
  await openDlg(p5);
  check('without a broker stop the ladder refuses to arm',
    /no broker stop/i.test(await txt(p5, '#ld-modal')) &&
    !(await p5.evaluate(() => !!document.querySelector('[data-arm]'))), await txt(p5, '#ld-modal'));
  await p5.context().close();

  // Shadow mode: the whole engine runs and nothing leaves the browser.
  state = pos(5010, 5011);
  const { page: p7, errs: e7 } = await openPage(browser);
  await openDlg(p7); await armIt(p7, 400, true);
  const sh = await led(p7);
  check('a shadow ladder arms without a token', !!sh && sh.state === 'armed' && sh.shadow === true,
    JSON.stringify(sh && { state: sh.state, shadow: sh.shadow }));
  const q = calls.length;
  state.positions[0].bid = 4978; state.positions[0].offer = 4979;
  await p7.waitForTimeout(3200);
  const rec = await led(p7);
  check('it records the rung it would have placed', !!rec && rec.rungs.length === 1, JSON.stringify(rec && rec.rungs));
  check('at the price it would have gone on', !!rec && Math.abs(rec.rungs[0].price - 4978) <= 1, JSON.stringify(rec && rec.rungs[0]));
  check('and marks it as never sent', !!rec && rec.rungs[0].shadow === true);
  check('no order reaches the worker', since(q).length === 0, JSON.stringify(since(q)));
  check('the row says shadow, not ladder',
    /shadow/i.test(await p7.evaluate(() => (document.querySelector('[data-ladder]') || {}).innerText || '')),
    await p7.evaluate(() => (document.querySelector('[data-ladder]') || {}).innerText || ''));
  state.positions[0].bid = 4948; state.positions[0].offer = 4949;
  await p7.waitForTimeout(3200);
  const fin = await led(p7);
  check('it runs the whole plan', !!fin && fin.rungs.length === 2 && fin.state === 'done', JSON.stringify(fin && fin.state));
  check('still sending nothing', since(q).length === 0, JSON.stringify(since(q)));
  check('no page errors in shadow mode', e7.length === 0, e7.slice(0, 2).join(' | '));
  await p7.context().close();

  // the cap is the same code path either way, so it has to hold in shadow too
  state = pos(5010, 5011);
  const { page: p8 } = await openPage(browser);
  await openDlg(p8); await armIt(p8, 250, true);
  state.positions[0].bid = 4978; state.positions[0].offer = 4979;
  await p8.waitForTimeout(3200);
  state.positions[0].bid = 4948; state.positions[0].offer = 4949;
  await p8.waitForTimeout(3400);
  const cap8 = await led(p8);
  check('a shadow ladder stops at its cap like a real one',
    !!cap8 && cap8.state === 'capped' && cap8.rungs.length === 1,
    JSON.stringify(cap8 && { state: cap8.state, rungs: cap8.rungs.length }));
  await p8.context().close();

  // A position that has gone takes its ladder with it.
  state = pos(5010, 5011);
  const { page: p6 } = await openPage(browser);
  await openDlg(p6); await armIt(p6, 400);
  check('the ladder is stored', !!(await led(p6)));
  state.positions = [];
  await p6.waitForTimeout(3200);
  check('closing the position removes its ladder', !(await led(p6)));
  await p6.context().close();
}

// The built-in book is a fallback. Where the worker offers market search this asks IG, which
// reaches everything the account can trade instead of twenty guesses — and must degrade quietly
// to the book on a worker that has not got the endpoint yet.
async function marketSearch(browser) {
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 1, level: 5000, bid: 5010, offer: 5011, stopLevel: 4900,
    contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser);
  const open = async pg => { await pg.evaluate(() => document.querySelector('[data-neworder]')?.click()); await pg.waitForTimeout(400); };
  const type = (pg, v) => pg.evaluate(t => { const i = document.querySelector('#or-epic');
    i.focus(); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const list = pg => pg.evaluate(() => Array.from(document.querySelectorAll('#or-epiclist .epic-row'))
    .map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  const groups = pg => pg.evaluate(() => Array.from(document.querySelectorAll('#or-epiclist .epic-group'))
    .map(g => g.innerText.trim()));

  await open(page);
  await type(page, 'live only');
  await page.waitForTimeout(1400);
  const found = await list(page);
  check('a market only IG knows about is found', found.some(r => /IX\.D\.LIVEONLY\.IFE\.IP/.test(r)), JSON.stringify(found));
  // innerText carries the uppercase text-transform, so compare on the words not the casing
  check('and is labelled as coming from IG',
    (await groups(page)).some(g => /from ig/i.test(g)), JSON.stringify(await groups(page)));
  check("IG's own type and expiry are shown, which is what tells contracts apart",
    found.some(r => /INDICES/.test(r) && /SEP-26/.test(r)), JSON.stringify(found));

  await type(page, 'sptrd');
  await page.waitForTimeout(1400);
  const mixed = await list(page);
  check('an epic the account has traded still comes first', /traded/i.test(mixed[0] || ''), JSON.stringify(mixed.slice(0, 2)));

  await type(page, 'live only');
  await page.waitForTimeout(1400);
  await page.evaluate(() => Array.from(document.querySelectorAll('#or-epiclist .epic-row'))
    .find(r => /LIVEONLY/.test(r.innerText)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.waitForTimeout(500);
  check('picking a live result fills its epic',
    (await page.evaluate(() => document.querySelector('#or-epic').value)) === 'IX.D.LIVEONLY.IFE.IP');
  await page.evaluate(() => { const i = document.querySelector('#or-size'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(400);
  check("and the summary names it rather than repeating the code",
    /Live Only Market/.test(await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#or-summary') || {}).innerText || ''));

  const before = calls.filter(c => c.p === '/markets').length;
  await type(page, 'live only');
  await page.waitForTimeout(1200);
  check('a repeated search is served from memory', calls.filter(c => c.p === '/markets').length === before,
    `${calls.filter(c => c.p === '/markets').length - before} extra calls`);
  check('no page errors searching markets', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();

  // A worker without the endpoint must not break the picker, and must be asked only once.
  state.marketsMissing = true;
  const { page: p2, errs: e2 } = await openPage(browser);
  await open(p2);
  const was = calls.filter(c => c.p === '/markets').length;
  await type(p2, 'dow mini');
  await p2.waitForTimeout(1400);
  const fell = await list(p2);
  check('without the endpoint it falls back to the built-in list',
    fell.length === 1 && /IX\.D\.DOW\.IMF\.IP/.test(fell[0]), JSON.stringify(fell));
  await type(p2, 'nasdaq');
  await p2.waitForTimeout(1400);
  check('and the missing endpoint is not asked again',
    calls.filter(c => c.p === '/markets').length - was === 1,
    `${calls.filter(c => c.p === '/markets').length - was} calls`);
  check('the book still works after that', (await list(p2)).length === 2, JSON.stringify(await list(p2)));
  check('no page errors when the endpoint is absent', e2.length === 0, e2.slice(0, 2).join(' | '));
  await p2.context().close();
}

// Two entries on one instrument are one exposure. Opening either one's chart has to show both,
// what each is doing, and what the pair costs together — and none of it may sit on a candle.
async function multiPosition(browser) {
  state = { orders: [], positions: [
    { dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500', direction: 'BUY', size: 0.2,
      level: 5000, bid: 5060, offer: 5061, stopLevel: 4900, limitLevel: 5200, contractSize: 1, currency: 'USD' },
    { dealId: 'D2', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500', direction: 'BUY', size: 0.4,
      level: 5040, bid: 5060, offer: 5061, stopLevel: 4900, limitLevel: 5250, contractSize: 1, currency: 'USD' },
  ] };
  const { page, errs } = await openPage(browser, { width: 1400, height: 900 });
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2400);
  const lines = () => page.evaluate(() => Chart.getChart(document.querySelector('#c-pos'))
    .options.plugins.levelLines.lines.map(l => ({ label: l.label, value: l.value, note: l.note || null })));
  const L = await lines();
  const legs = L.filter(l => l.label.startsWith('Long'));
  const avg = L.find(l => l.label.startsWith('Avg'));

  check('both positions are drawn', legs.length === 2, JSON.stringify(L.map(l => l.label)));
  check('each carries its own size',
    legs.some(l => /0\.2/.test(l.label)) && legs.some(l => /0\.4/.test(l.label)), JSON.stringify(legs.map(l => l.label)));
  check('and its own running P&L', legs.every(l => !!l.note), JSON.stringify(legs));
  check('an average cost line is drawn', !!avg, JSON.stringify(L.map(l => l.label)));
  // 0.2 at 5000 and 0.4 at 5040 weight to 5026.67, not the 5020 a plain mean would give
  check('weighted by size, not a plain mean', !!avg && Math.abs(avg.value - 5026.67) < 0.1, avg && String(avg.value));
  check('carrying the total for the instrument', !!avg && !!avg.note, avg && String(avg.note));
  const num = t => parseFloat(String(t).replace(/[^0-9.]/g, '')) * (/[−-]/.test(String(t)) ? -1 : 1);
  check('and that total is the sum of the parts',
    Math.abs(num(avg.note) - (num(legs[0].note) + num(legs[1].note))) < 0.02,
    `${legs.map(l => l.note).join(' + ')} vs ${avg.note}`);
  check('a shared stop is drawn once, not twice', L.filter(l => l.label === 'stop').length === 1);
  check('but differing targets are both kept', L.filter(l => l.label === 'target').length === 2);
  check('the header counts them',
    /2 positions/.test(await page.evaluate(() => (document.querySelector('#chartcard .card-title small') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#chartcard .card-title small') || {}).innerText || ''));

  // Labels live outside the plot, so no amount of panning can put one over a candle.
  const geom = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#c-pos'));
    return { gutter: Math.round(c.width - c.chartArea.right), width: Math.round(c.width) }; });
  check('the price gutter is wide enough to hold them', geom.gutter >= 52, JSON.stringify(geom));
  check('and does not swallow the chart', geom.gutter <= geom.width * 0.35, JSON.stringify(geom));

  await page.evaluate(() => document.querySelector('[data-chartclose]')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll('.symlink')[1]?.click());
  await page.waitForTimeout(2400);
  check('opening the sibling shows the same pair',
    (await lines()).filter(l => l.label.startsWith('Long')).length === 2);
  check('no page errors with two positions', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();

  // One position on its own keeps the plain wording and grows no average line.
  state.positions = [state.positions[0]];
  const { page: p2 } = await openPage(browser, { width: 1400, height: 900 });
  await p2.evaluate(() => document.querySelector('.symlink')?.click());
  await p2.waitForTimeout(2400);
  const solo = await p2.evaluate(() => Chart.getChart(document.querySelector('#c-pos'))
    .options.plugins.levelLines.lines.map(l => l.label));
  check('a single position is still just "entry"',
    solo.includes('entry') && !solo.some(l => l.startsWith('Avg')), JSON.stringify(solo));
  await p2.context().close();
}

// The Liquid book has no credentials of its own — a URL that answers with Liquid's shapes is the
// whole contract. What matters is that polling it adds new fills once and only once, and that a
// broken endpoint says so rather than quietly showing stale numbers as if they were live.
const LQ_CLOSE = (px, pnl, hash) => ({ time: '2026-09-10T01:54:59.646Z', asset: 'WTIOIL', side: 'sell',
  direction: 'Close Long', size: '10.828', price: String(px), fee: '0.60111', closedPnl: String(pnl), txHash: hash });

async function liquidSync(browser) {
  state = { orders: [], positions: [], lqRows: [LQ_CLOSE(94.67, -4.699352, '0xbbb')] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`;
    s.settings.liquidToken = 'LQTOK'; s.settings.liquidSecs = 5;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const book = () => page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    return { trades: s.trades.filter(t => t.kind === 'trade').length, positions: (s.lq.positions || []).length }; });
  const hits = () => calls.filter(c => c.p === '/liquid');

  check('the IG book does not poll Liquid', hits().length === 0, `${hits().length} calls`);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(1500);
  check('opening the Liquid book syncs it without a paste', hits().length >= 1, `${hits().length} calls`);
  const b1 = await book();
  check('positions arrive', b1.positions === 1, JSON.stringify(b1));
  check('and so does the realised history', b1.trades === 1, JSON.stringify(b1));
  check('the token is sent as a bearer', /^Bearer LQTOK$/.test((hits()[0] || {}).auth || ''), (hits()[0] || {}).auth);

  await page.evaluate(() => document.querySelector('[data-section="open"]').click());
  await page.waitForTimeout(500);
  check('the card says it is live',
    /Live/.test(await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || ''));

  // the same window comes back on every poll; it must not pile up
  const n1 = hits().length;
  await page.waitForTimeout(7000);
  check('it keeps polling', hits().length > n1, `${n1} -> ${hits().length}`);
  check('but re-reading the same fills adds nothing', (await book()).trades === 1, JSON.stringify(await book()));

  state.lqRows = [LQ_CLOSE(94.67, -4.699352, '0xbbb'), LQ_CLOSE(96.2, 8.4, '0xddd')];
  await page.waitForTimeout(7000);
  check('a genuinely new fill is picked up', (await book()).trades === 2, JSON.stringify(await book()));

  state.lqStatus = 502;
  await page.waitForTimeout(8000);
  check('a broken endpoint is reported, not hidden',
    /error/i.test(await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || ''));
  check('and what it already had is kept', (await book()).trades === 2);
  const n2 = hits().length;
  await page.waitForTimeout(6000);
  check('a failing endpoint is backed off, not hammered', hits().length - n2 <= 2, `${hits().length - n2} calls in 6s`);

  state.lqStatus = 0;
  await page.waitForTimeout(9000);
  check('and it recovers on its own once the endpoint does',
    !/error/i.test(await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || ''));

  const n3 = hits().length;
  await page.selectOption('#venue', 'ig');
  await page.waitForTimeout(6000);
  check('switching back to IG stops the Liquid poll', hits().length - n3 <= 1, `${hits().length - n3} calls after leaving`);

  check('no page errors through Liquid autosync', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// With a wallet address and no proxy, the page reads Hyperliquid's public info endpoint itself.
// Its responses are intercepted here with the shapes their documentation describes, which is the
// only way to check the mapping without reaching the real thing.
const HL_STATE = {
  marginSummary: { accountValue: '82.62', totalMarginUsed: '81.94' },
  withdrawable: '0.68',
  assetPositions: [
    { type: 'oneWay', position: { coin: 'xyz:CL', szi: '14.183', entryPx: '94.479', unrealizedPnl: '14.2',
      returnOnEquity: '0.212', leverage: { type: 'isolated', value: 20 }, liquidationPx: '92.0035', marginUsed: '81.94' } },
    // signed size: negative is a short, and the dashboard wants a side and an unsigned number
    { type: 'oneWay', position: { coin: 'ETH', szi: '-2.5', entryPx: '3000', unrealizedPnl: '-12',
      leverage: { type: 'cross', value: 5 }, liquidationPx: '3400', marginUsed: '1500' } },
    { type: 'oneWay', position: { coin: 'BTC', szi: '0', entryPx: '0' } },
  ],
};
const HL_FILLS = [
  { coin: 'CL', px: '94.67', sz: '10.828', side: 'A', time: 1789005299646, dir: 'Close Long',
    closedPnl: '-4.699352', fee: '0.60111', hash: '0xbbb' },
  // Hyperliquid stamps every fill with closedPnl, "0.0" on the ones that opened a position. A
  // fixture that left the field off hid a bug where that zero read as a realised result.
  { coin: 'CL', px: '95.104', sz: '10.515', side: 'B', time: 1789003787639, dir: 'Open Long',
    closedPnl: '0.0', fee: '0.586', hash: '0xccc' },
  // one unreadable timestamp: new Date(NaN).toISOString() throws, and the throw used to take the
  // whole response with it — every good fill in it, on every poll from then on
  { coin: 'SOL', px: '150', sz: '3', side: 'A', time: 'not-a-time', dir: 'Close Long',
    closedPnl: '9', fee: '0.1', hash: '0xeee' },
];

async function hyperliquidDirect(browser) {
  state = { orders: [], positions: [] };
  const { page, errs } = await openPage(browser);
  const seen = [];
  await page.route('https://api.hyperliquid.xyz/info', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    seen.push(body);
    if (state.hlDown) return route.fulfill({ status: 500, body: 'upstream down' });
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body.type === 'userFills' ? HL_FILLS : HL_STATE) });
  });
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    // a stand-in: the repo is public, and a real address here would tie it to whoever owns it
    s.settings.liquidAddress = '0x1111111111111111111111111111111111111111';
    s.settings.liquidDex = 'xyz'; s.settings.liquidSecs = 5; s.settings.liquidUrl = '';
    localStorage.setItem('ledger:v4', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(1600);

  check('both info calls are made', seen.length >= 2, JSON.stringify(seen.map(b => b.type)));
  check('each carries the wallet address',
    seen.every(b => b.user === '0x1111111111111111111111111111111111111111'), JSON.stringify(seen[0]));
  check('and the builder prefix, without which the answer is empty',
    seen.every(b => b.dex === 'xyz'), JSON.stringify(seen[0]));

  const lq = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    return { pos: s.lq.positions || [], trades: s.trades.filter(t => t.kind === 'trade'),
             costs: s.trades.filter(t => t.kind === 'cost').length }; });
  check('a zero-size position is dropped', lq.pos.length === 2, JSON.stringify(lq.pos.map(p => p.name)));
  const cl = lq.pos.find(p => p.name === 'xyz:CL'), eth = lq.pos.find(p => p.name === 'ETH');
  check('a positive size reads long', !!cl && cl.long && cl.size === 14.183, JSON.stringify(cl));
  check('a negative size reads short, with the sign taken off',
    !!eth && !eth.long && eth.size === 2.5, JSON.stringify(eth));
  check('leverage comes through', !!cl && cl.leverage === 20, JSON.stringify(cl && cl.leverage));
  check('the builder prefix is not written twice onto a coin that already carries it',
    !!cl && cl.symbol === 'xyz:CL', cl && cl.symbol);
  check('so does the liquidation price', !!cl && cl.liq === 92.0035);
  check('the closing fill becomes a trade', lq.trades.length === 1, JSON.stringify(lq.trades));
  check('a fill with an unreadable timestamp is skipped on its own',
    !lq.trades.some(t => t.instrument === 'SOL'), JSON.stringify(lq.trades.map(t => t.instrument)));
  check('the opening fill becomes a fee, not a trade', lq.costs === 1);
  check('and the entry is recovered from the realised P&L',
    Math.abs(lq.trades[0].openLevel - 95.104) < 0.001, String(lq.trades[0].openLevel));
  check('and the rest of the response survives it',
    lq.trades[0].instrument === 'CL' && lq.pos.length === 2, JSON.stringify(lq.trades[0].instrument));

  await page.evaluate(() => document.querySelector('[data-section="open"]').click());
  await page.waitForTimeout(400);
  check('the card reports it live',
    /Live/.test(await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || ''));

  // a browser refused by CORS, or an upstream that falls over, must say so rather than look fine
  state.hlDown = true;
  await page.waitForTimeout(8000);
  check('an upstream failure is reported',
    /error/i.test(await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || '')),
    await page.evaluate(() => (document.querySelector('#open .live') || {}).innerText || ''));
  check('and what it already read is kept',
    (await page.evaluate(() => (JSON.parse(localStorage.getItem('ledger:v4')).lq.positions || []).length)) === 2);
  check('no page errors reading Hyperliquid', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Every row below is one that used to come out wrong. A venue's export is not a friendly
// document: it quotes small-cap coins in exponent notation, pays maker rebates as negative fees,
// and leaves fields blank. These are the shapes that broke the conversion, kept as a fence.
const LQ_ROW = o => ({ time: '2026-09-10T01:00:00.000Z', asset: 'X', side: 'sell',
  direction: 'Close Long', size: '1', price: '100', fee: '0', txHash: '0x0', ...o });
const EDGE_ROWS = [
  LQ_ROW({ asset: 'PEPE', size: '1e6', price: '1.5e-7', closedPnl: '2.5e-2', txHash: '0x1' }),
  LQ_ROW({ asset: 'HUGE', price: '1e308', closedPnl: '1', txHash: '0x2' }),
  LQ_ROW({ asset: 'ZERO', size: '0', closedPnl: '5', txHash: '0x3' }),
  LQ_ROW({ asset: 'REB', size: '2', price: '50', fee: '-0.4', closedPnl: '10', txHash: '0x4' }),
  LQ_ROW({ asset: 'REBO', direction: 'Open Long', size: '2', price: '50', fee: '-0.4', txHash: '0x5' }),
  LQ_ROW({ asset: 'FREE', direction: 'Open Long', fee: '0', txHash: '0x6' }),
  LQ_ROW({ asset: 'NOSIDE', direction: '', side: '', closedPnl: '3', txHash: '0x7' }),
  LQ_ROW({ asset: 'SIDEONLY', direction: '', side: 'buy', size: '2', price: '50', closedPnl: '10', txHash: '0x8' }),
  LQ_ROW({ asset: 'COMMA', size: '2', price: '1,234.5', closedPnl: '9', txHash: '0x9' }),
  LQ_ROW({ asset: 'JUNK', price: 'abc', closedPnl: '1', txHash: '0xa' }),
];

async function liquidEdges(browser) {
  state = { orders: [], positions: [] };
  const { page, errs } = await openPage(browser);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(400);

  // the demo set is IG-shaped; loading it here would bury real Liquid history under samples
  await page.evaluate(() => document.querySelector('[data-act="demo"]').click());
  await page.waitForTimeout(400);
  check('the demo set is refused on the Liquid book',
    !(await page.evaluate(() => !!document.querySelector('#m-review.open'))));
  check('and nothing of it lands',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades.length)) === 0);

  await page.evaluate(() => document.querySelector('[data-lqimport]').click());
  await page.waitForTimeout(250);
  await page.fill('#lq-json', JSON.stringify({ rows: EDGE_ROWS }));
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('[data-lqgo]').click());
  await page.waitForTimeout(600);

  const all = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);
  const of = n => all.filter(t => t.instrument === n);
  const one = n => of(n)[0] || {};

  // 1e6 once read as 16, and 1.5e-7 as 1.5: the parser stripped the exponent instead of rejecting
  const pepe = one('PEPE');
  check('a size in exponent notation is read whole, not stripped to its digits',
    pepe.size === '1000000', String(pepe.size));
  check('and so is a sub-cent price', pepe.closeLevel === 1.5e-7, String(pepe.closeLevel));
  // the entry was rounded to six places, which is zero for a coin quoted at 1.5e-7
  check('the entry recovered from a sub-cent close survives rounding',
    Math.abs(pepe.openLevel - 1.25e-7) < 1e-15, String(pepe.openLevel));
  check('and the P&L is kept finer than money', pepe.pnl === 0.025, String(pepe.pnl));

  check('a price past anything a venue quotes is dropped, not read as 1308', of('HUGE').length === 0,
    JSON.stringify(of('HUGE')));
  check('a close with no size is dropped rather than given a fabricated entry',
    of('ZERO').length === 0, JSON.stringify(of('ZERO')));
  check('a price that is not a number is dropped', of('JUNK').length === 0, JSON.stringify(of('JUNK')));

  const reb = one('REB');
  check('a maker rebate on a close adds to the P&L instead of being charged',
    reb.pnl === 10.4, String(reb.pnl));
  check('the entry comes back from the realised P&L', reb.openLevel === 45, String(reb.openLevel));
  const rebo = one('REBO');
  check('a rebate on an opening fill is booked as a credit', rebo.kind === 'cost' && rebo.pnl === 0.4,
    JSON.stringify(rebo));
  check('an opening fill that cost nothing books nothing', of('FREE').length === 0);

  check('a close with neither a direction nor a readable side is dropped, not guessed short',
    of('NOSIDE').length === 0, JSON.stringify(of('NOSIDE')));
  const so = one('SIDEONLY');
  check('a missing direction falls back to the side', so.direction === 'SELL', String(so.direction));
  check('and the entry is mirrored for that side', so.openLevel === 55, String(so.openLevel));

  const cm = one('COMMA');
  check('a thousands separator is still read', cm.closeLevel === 1234.5, String(cm.closeLevel));
  check('with the entry to match', cm.openLevel === 1230, String(cm.openLevel));

  check('no page errors converting hostile rows', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Rebuilding the panel throws the <canvas> away, and with it a drag in progress, the pointer
// capture and the crosshair. On a market that has not ticked this used to happen on every poll —
// twice a second's worth of work, and a chart you could not hold on to.
async function chartUnderPolling(browser) {
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'IX.D.SPTRD.IFE.IP', market: 'US 500',
    direction: 'BUY', size: 2, level: 5000, bid: 5062, offer: 5063, stopLevel: 4980,
    limitLevel: 5090, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser, { width: 1400, height: 900 });
  await page.evaluate(() => document.querySelector('.symlink')?.click());
  await page.waitForTimeout(2200);
  const st = () => page.evaluate(() => window.__chart && window.__chart());
  const mark = () => page.evaluate(() => { window.__cv = document.querySelector('#c-pos'); return !!window.__cv; });
  const same = () => page.evaluate(() => window.__cv === document.querySelector('#c-pos') && window.__cv.isConnected);
  const pnl = () => page.evaluate(() => (document.querySelector('#chartcard .stat-row b') || {}).innerText || '');

  check('the chart is open', !!(await st()));
  await mark();
  // the price is unchanged between polls, which is the case that used to rebuild it every time
  await page.waitForTimeout(7000);
  check('a flat market leaves the canvas alone across several polls', await same());

  // the numbers around it must still move when the price does
  const before = await pnl();
  state.positions[0].bid = 5090; state.positions[0].offer = 5091;
  await repoll(page);
  check('but the unrealised P&L still follows the price', (await pnl()) !== before,
    `${before} -> ${await pnl()}`);
  check('and it did not need a new canvas to do it', await same());

  // a stop moved by anything other than a price tick still reaches the chart
  state.positions[0].stopLevel = 5010;
  await repoll(page);
  const lv = await page.evaluate(() => { const c = Chart.getChart(document.querySelector('#c-pos'));
    return (c.options.plugins.levelLines.lines || []).map(l => l.value); });
  check('a stop that moved on its own is redrawn', lv.some(v => Math.abs(v - 5010) < 0.5), JSON.stringify(lv));

  // a pan that spans a poll: the drag lives on the canvas, so a swap silently drops it
  const b = await (await page.$('#c-pos')).boundingBox();
  await page.evaluate(() => document.querySelector('[data-zoom="fit"]')?.click());
  await page.waitForTimeout(300);
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(b.x + b.width * 0.8 - i * 25, b.y + b.height * 0.5);
  const mid = (await st()).x.min;
  await page.waitForTimeout(2600);                       // a poll lands here
  for (let i = 5; i <= 10; i++) await page.mouse.move(b.x + b.width * 0.8 - i * 25, b.y + b.height * 0.5);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = (await st()).x.min;
  check('a drag that spans a poll keeps panning', Math.abs(after - mid) > 0.5,
    `${mid.toFixed(2)} -> ${after.toFixed(2)}`);

  // orders are polled on their own clock and have nothing to do with the chart
  await mark();
  await page.waitForTimeout(21000);
  check('the orders poll does not rebuild the chart either', await same());

  check('no page errors while the chart sits through polls', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Two books, one page. Every feed here is asynchronous, so a response can land after you have
// already switched — and both of these writes go straight into whichever book is open at the time
// and are then persisted. One of them replaces every trade in it.
// A sync with nothing usable in it throws before it writes, so it proves nothing about what a
// landing sync does to the open book. This one parses.
const IG_TX = [{ dateUtc: '2026-09-08T10:00:00', date: '08/09/26', instrumentName: 'Wall Street Cash',
  transactionType: 'DEAL', size: '+1', openLevel: '40000', closeLevel: '40080',
  profitAndLoss: '80.00', currency: 'GBP', reference: 'IGREF1', cashTransaction: false }];

async function venueIsolation(browser) {
  state = { orders: [], positions: [], lqRows: [LQ_CLOSE(94.67, -4.699352, '0xrace')], lqDelay: 2500 };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.settings.liquidSecs = 5;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const book = v => page.evaluate(k => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    const b = s.venue === k ? s : ((s.books || {})[k] || {});
    const tr = b.trades || [];
    return { trades: tr.length, fromLiquid: tr.filter(t => t.account === 'Liquid').length,
             lqPos: ((b.lq || {}).positions || []).length }; }, v);

  const ig0 = await book('ig');
  check('the IG book starts with the demo set', ig0.trades > 0 && ig0.fromLiquid === 0, JSON.stringify(ig0));

  // switch to Liquid, then straight back before the slow venue answers
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(300);
  await page.selectOption('#venue', 'ig');
  await page.waitForTimeout(4000);
  const ig1 = await book('ig');
  check('a Liquid sync that lands after the switch does not write into the IG book',
    ig1.fromLiquid === 0 && ig1.lqPos === 0, JSON.stringify(ig1));
  check('and it leaves the IG trades exactly as they were', ig1.trades === ig0.trades,
    `${ig0.trades} -> ${ig1.trades}`);

  // let Liquid fill its own book properly
  state.lqDelay = 0;
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(2000);
  const lq0 = await book('liquid');
  check('the Liquid book fills on its own tab', lq0.trades === 1 && lq0.lqPos === 1, JSON.stringify(lq0));

  // now the mirror: an IG sync in flight while the venue moves to Liquid. It does not merge —
  // it replaces every trade in the open book.
  await page.selectOption('#venue', 'ig');
  await page.waitForTimeout(1500);
  state.syncDelay = 2500; state.syncTx = IG_TX;
  calls = [];
  await page.evaluate(() => document.querySelector('[data-act="sync"]')?.click());
  await page.waitForTimeout(300);
  check('the IG sync is genuinely in flight when the venue changes',
    calls.some(c => c.p === '/sync'), JSON.stringify(calls.map(c => c.p)));
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(4000);
  const lq1 = await book('liquid');
  check('an IG sync that lands after the switch does not wipe the Liquid book',
    lq1.trades === lq0.trades && lq1.fromLiquid === lq0.fromLiquid, JSON.stringify(lq1));
  check('and none of IG\'s own rows are left in it',
    !(await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades
      .some(t => t.reference === 'IGREF1'))));

  // the dropped sync is not simply lost: coming back to IG runs it again
  state.syncDelay = 0;
  calls = [];
  await page.selectOption('#venue', 'ig');
  await page.waitForTimeout(2000);
  check('and returning to IG re-runs the sync that was dropped',
    calls.some(c => c.p === '/sync'), JSON.stringify(calls.map(c => c.p)));

  check('no page errors switching books under load', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// A stop armed here is armed against a real IG position. Reading the other book is not a reason
// to stop watching it, and the dialog does not say it is.
async function stopsAcrossVenues(browser) {
  state = { orders: [], positions: [{ dealId: 'D1', epic: 'E', market: 'US 500', direction: 'BUY',
    size: 2, level: 5000, bid: 5100, offer: 5101, contractSize: 1, currency: 'USD' }] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.closeToken = 'CLOSETOK'; s.settings.liquidUrl = `http://localhost:${p}/liquid`;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => document.querySelector('#subnav [data-section="open"]')?.click());
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.querySelector('[data-softstop]')?.click());
  await page.waitForTimeout(400);
  await page.fill('#ss-price', '5050');
  await page.evaluate(() => document.querySelector('[data-arm]')?.click());
  await page.waitForTimeout(700);
  check('the stop is armed', (await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    return (s.settings.softStops.D1 || {}).state; })) === 'armed');

  await page.selectOption('#venue', 'liquid');
  // long enough that any poll already scheduled has come and gone
  await page.waitForTimeout(9000);
  calls = [];
  state.positions[0].bid = 5040; state.positions[0].offer = 5041;
  await page.waitForTimeout(7000);
  check('an armed stop is still watched from the other book',
    calls.filter(c => c.p === '/close').length === 1, `${calls.filter(c => c.p === '/close').length} sends`);
  check('but the orders feed is not polled there, because nothing reads it',
    calls.filter(c => c.p === '/orders').length === 0, `${calls.filter(c => c.p === '/orders').length} calls`);
  check('and the other book is not showing IG positions',
    !/US 500/.test(await page.evaluate(() => document.querySelector('#open')?.innerText || '')));

  // with nothing armed there is nothing to watch, and IG's request budget is small
  calls = [];
  await page.waitForTimeout(7000);
  check('once it has fired, the other book stops polling IG',
    calls.filter(c => c.p === '/positions').length === 0, `${calls.filter(c => c.p === '/positions').length} polls`);

  check('no page errors watching a stop from another book', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// A market close eats several levels of the book and the venue reports each one. Folding them is
// what makes the row a trade rather than a book level — and what stops a fee-only leg counting
// against a win rate. Sizes and prices here are real shapes: three legs of one CL exit.
const LQ_FILL = o => ({ time: '2026-09-10T10:34:12.400Z', asset: 'xyz:CL', side: 'sell',
  direction: 'Close Long', size: '1', price: '94.67', fee: '0', txHash: '0xblock1', ...o });

async function liquidFillFolding(browser) {
  state = { orders: [], positions: [], lqRows: [
    // one order, three fills, one block
    // every leg closes against the same entry, 94.30, which is how a venue reports them
    LQ_FILL({ size: '0.648', price: '94.60', fee: '0.036', closedPnl: '0.1944', txHash: '0xb1' }),
    LQ_FILL({ size: '1.051', price: '94.65', fee: '0.058', closedPnl: '0.36785', txHash: '0xb1' }),
    LQ_FILL({ size: '10',    price: '94.70', fee: '0.555', closedPnl: '4.0', txHash: '0xb1' }),
    // a different block on the same market and side: a separate decision, kept separate
    LQ_FILL({ time: '2026-09-10T10:13:02.100Z', size: '4.404', price: '94.20', fee: '0.244',
              closedPnl: '0.024', txHash: '0xb2' }),
    // the opening side of an order: two fee legs, no P&L, folded the same way
    LQ_FILL({ time: '2026-09-10T09:42:00.000Z', direction: 'Open Long', size: '3', price: '94.10',
              fee: '0.165', closedPnl: '', txHash: '0xb3' }),
    LQ_FILL({ time: '2026-09-10T09:42:00.000Z', direction: 'Open Long', size: '3.888', price: '94.12',
              fee: '0.214', closedPnl: '', txHash: '0xb3' }),
  ] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.settings.liquidSecs = 5;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(2000);
  const rows = () => page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);

  const all = await rows();
  check('three fills of one order become one trade, not three',
    all.filter(t => t.kind === 'trade').length === 2, JSON.stringify(all.map(t => `${t.kind}:${t.size}`)));
  const big = all.find(t => t.kind === 'trade' && t.fills === 3);
  check('and it says how many levels it took', !!big, JSON.stringify(all.map(t => t.fills)));
  check('the size is the sum of the legs, without the float noise of summing them',
    !!big && big.size === '11.699', big && big.size);
  // 0.648*94.60 + 1.051*94.65 + 10*94.70 = 1107.77795 over 11.699
  check('the close is the size-weighted price the order actually got',
    !!big && Math.abs(big.closeLevel - 94.68996922813915) < 1e-9, big && String(big.closeLevel));
  // the whole point of folding on the totals: the entry comes back as the one the position held,
  // not an average of three averages
  check('and the entry recovers as the entry the position actually had',
    !!big && Math.abs(big.openLevel - 94.30) < 1e-9, big && String(big.openLevel));
  check('the P&L is the legs summed, net of every leg\'s fee',
    !!big && Math.abs(big.pnl - 3.91325) < 1e-6, big && String(big.pnl));

  const other = all.find(t => t.kind === 'trade' && t.fills == null);
  check('a different block on the same market and side stays its own trade',
    !!other && other.size === '4.404', other && other.size);
  check('and a fee-only close keeps reading as the fee it is',
    !!other && Math.abs(other.pnl - (0.024 - 0.244)) < 1e-6, other && String(other.pnl));

  const cost = all.find(t => t.kind === 'cost');
  check('the opening fills fold into one fee row', !!cost && cost.fills === 2, JSON.stringify(cost));
  check('with both legs charged', !!cost && Math.abs(cost.pnl + 0.379) < 1e-6, cost && String(cost.pnl));

  // the same window comes back on every poll and must not pile up or drift
  const n = all.length;
  await page.waitForTimeout(7000);
  check('re-reading the same fills changes nothing', (await rows()).length === n,
    `${n} -> ${(await rows()).length}`);

  // a resting order that fills across two polls grows the row it already filed
  state.lqRows.push(LQ_FILL({ size: '2', price: '94.80', fee: '0.111', closedPnl: '1.0', txHash: '0xb1' }));
  await page.waitForTimeout(7000);
  const grown = (await rows()).find(t => t.reference === (big || {}).reference);
  check('a block that fills further grows its trade instead of adding a second one',
    (await rows()).length === n && !!grown && grown.fills === 4, JSON.stringify(grown && grown.size));
  check('and the P&L grows with it', !!grown && Math.abs(grown.pnl - 4.80225) < 1e-6,
    grown && String(grown.pnl));
  check('while the entry it closed against stays put',
    !!grown && Math.abs(grown.openLevel - 94.30) < 1e-9, grown && String(grown.openLevel));

  check('no page errors folding fills', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Rows saved one-per-fill before folding existed have to become the same rows a fresh sync would
// write, or the next sync files a second copy of every order alongside the first.
async function liquidFillMigration(browser) {
  state = { orders: [], positions: [], lqRows: [
    LQ_FILL({ size: '0.648', price: '94.60', fee: '0.036', closedPnl: '0.236', txHash: '0xb1' }),
    LQ_FILL({ size: '1.051', price: '94.65', fee: '0.058', closedPnl: '0.388', txHash: '0xb1' }),
  ] };
  const { page, errs } = await openPage(browser);
  // written the way the previous build wrote them: one row per fill, LQ-<hash>-<side>-<size>-<price>
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.settings.liquidSecs = 5;
    s.venue = 'liquid';
    s.books = { ig: { trades: s.trades }, liquid: { trades: [
      { kind: 'trade', date: '2026-09-10', time: '10:34', instrument: 'xyz:CL', direction: 'BUY',
        size: '0.648', openLevel: 94.2915, closeLevel: 94.6, currency: 'USD', pnl: 0.2,
        reference: 'LQ-0xb1-sell-0.648-94.6', openTs: '', closeTs: '2026-09-10T10:34:12.400Z',
        account: 'Liquid', id: 'ref:LQ-0xb1-sell-0.648-94.6' },
      { kind: 'trade', date: '2026-09-10', time: '10:34', instrument: 'xyz:CL', direction: 'BUY',
        size: '1.051', openLevel: 94.2915, closeLevel: 94.65, currency: 'USD', pnl: 0.33,
        reference: 'LQ-0xb1-sell-1.051-94.65', openTs: '', closeTs: '2026-09-10T10:34:12.400Z',
        account: 'Liquid', id: 'ref:LQ-0xb1-sell-1.051-94.65' },
    ] } };
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const rows = () => page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);

  const after = await rows();
  check('rows saved one per fill are folded on load', after.length === 1, JSON.stringify(after.map(t => t.size)));
  check('into the size they always summed to', after[0].size === '1.699', after[0].size);
  check('carrying the P&L they always summed to', Math.abs(after[0].pnl - 0.53) < 1e-9, String(after[0].pnl));
  check('and the entry both legs shared', Math.abs(after[0].openLevel - 94.2915) < 1e-6, String(after[0].openLevel));

  // the point of matching the reference: the very next sync must recognise its own row
  await page.waitForTimeout(7000);
  const settled = await rows();
  check('and the next sync recognises it instead of filing a second copy',
    settled.length === 1, JSON.stringify(settled.map(t => `${t.reference} ${t.size}`)));
  check('no page errors folding stored fills', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Reversing a position closes one side and opens the other in a single stroke. The venue reports
// the realised P&L on it, and a venue that splits the stroke into two rows reports that same money
// on both halves. Only the half that closed has realised anything.
async function liquidReversals(browser) {
  const R = o => ({ time: '2026-09-09T22:02:11.000Z', asset: '#19310', side: 'sell',
    size: '75', price: '0.62', fee: '0.1', txHash: '0xrev', ...o });
  state = { orders: [], positions: [], lqRows: [
    // the shape that double counted: one reversal, reported as a close and an open, the same
    // money on each — one +$29.97 long and one +$29.97 short, same size, same second
    R({ direction: 'Close Long', closedPnl: '29.97', side: 'sell' }),
    R({ direction: 'Open Short', closedPnl: '29.97', side: 'sell', fee: '0.2' }),
    // an ordinary opening fill, stamped the way the live endpoint stamps one
    R({ time: '2026-09-09T21:00:00.000Z', asset: 'xyz:CL', direction: 'Open Long', size: '10.725',
        price: '94.1', closedPnl: '0.0', fee: '0.62', side: 'buy', txHash: '0xopen' }),
    // a reversal the other way: the short is the half that closed
    R({ time: '2026-09-09T20:00:00.000Z', asset: 'xyz:SP500', direction: 'Short > Long',
        size: '0.358', price: '6600', closedPnl: '-7.0', fee: '0.16', txHash: '0xflip' }),
    // scratched: it closed, it just made nothing. The fee is still real, and so is the trade.
    R({ time: '2026-09-09T19:00:00.000Z', asset: 'xyz:GOLD', direction: 'Close Long',
        size: '0.038', price: '4397', closedPnl: '0.0', fee: '0.05', txHash: '0xflat' }),
  ] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.settings.liquidSecs = 5;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(2000);
  const all = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);
  const of = n => all.filter(t => t.instrument === n);

  const rev = of('#19310').filter(t => t.kind === 'trade');
  check('a reversal reported as two halves is one trade, not one on each side',
    rev.length === 1, JSON.stringify(of('#19310').map(t => `${t.kind}:${t.direction}:${t.pnl}`)));
  check('and it is the half that closed', rev.length === 1 && rev[0].direction === 'BUY',
    rev[0] && rev[0].direction);
  check('the money is counted once', rev.length === 1 && Math.abs(rev[0].pnl - 29.87) < 1e-6,
    rev[0] && String(rev[0].pnl));
  check('the opening half still pays its fee', of('#19310').some(t => t.kind === 'cost' && Math.abs(t.pnl + 0.2) < 1e-6),
    JSON.stringify(of('#19310').filter(t => t.kind === 'cost').map(t => t.pnl)));

  const cl = of('xyz:CL');
  check('an opening fill stamped closedPnl "0.0" is a fee, not a trade',
    cl.length === 1 && cl[0].kind === 'cost', JSON.stringify(cl.map(t => `${t.kind}:${t.pnl}`)));
  check('and it is the fee that was actually paid', cl[0] && Math.abs(cl[0].pnl + 0.62) < 1e-6,
    cl[0] && String(cl[0].pnl));

  const flat = of('xyz:GOLD').filter(t => t.kind === 'trade');
  check('a close that landed exactly flat is still a trade',
    flat.length === 1 && flat[0].pnl === -0.05, JSON.stringify(of('xyz:GOLD').map(t => `${t.kind}:${t.pnl}`)));
  check('and its entry is where it closed', flat[0] && flat[0].openLevel === flat[0].closeLevel,
    flat[0] && `${flat[0].openLevel} / ${flat[0].closeLevel}`);

  const sp = of('xyz:SP500').filter(t => t.kind === 'trade');
  check('"Short > Long" closed the short, not the long',
    sp.length === 1 && sp[0].direction === 'SELL', JSON.stringify(sp.map(t => t.direction)));

  check('no page errors reading reversals', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// A pair already written by the old rules stays written: no sync overwrites a row it will never
// produce again. It has to be cleared where it sits.
async function liquidTwinRepair(browser) {
  state = { orders: [], positions: [], lqRows: [] };
  const { page, errs } = await openPage(browser);
  const twin = (ref, dir) => ({ kind: 'trade', date: '2026-09-09', time: '22:02', instrument: '#19310',
    direction: dir, size: '75', openLevel: 0.22, closeLevel: 0.62, currency: 'USD', pnl: 29.97,
    reference: ref, openTs: '', closeTs: '2026-09-09T22:02:11.000Z', account: 'Liquid', id: `ref:${ref}` });
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.venue = 'liquid';
    s.books = { ig: { trades: s.trades }, liquid: { trades: [
      { kind: 'trade', date: '2026-09-09', time: '22:02', instrument: '#19310', direction: 'BUY',
        size: '75', openLevel: 0.22, closeLevel: 0.62, currency: 'USD', pnl: 29.97,
        reference: 'LQ2-0xrev-#19310-L', openTs: '', closeTs: '2026-09-09T22:02:11.000Z',
        account: 'Liquid', id: 'ref:LQ2-0xrev-#19310-L' },
      { kind: 'trade', date: '2026-09-09', time: '22:02', instrument: '#19310', direction: 'SELL',
        size: '75', openLevel: 1.02, closeLevel: 0.62, currency: 'USD', pnl: 29.97,
        reference: 'LQ2-0xrev-#19310-S', openTs: '', closeTs: '2026-09-09T22:02:11.000Z',
        account: 'Liquid', id: 'ref:LQ2-0xrev-#19310-S' },
      // a genuine pair that must survive: same market and money, but hours apart
      { kind: 'trade', date: '2026-09-09', time: '09:49', instrument: '#19310', direction: 'SELL',
        size: '75', openLevel: 0.6, closeLevel: 0.59, currency: 'USD', pnl: -0.4,
        reference: 'LQ2-0xearlier-#19310-S', openTs: '', closeTs: '2026-09-09T09:49:00.000Z',
        account: 'Liquid', id: 'ref:LQ2-0xearlier-#19310-S' },
    ] } };
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const all = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);

  check('a pair already written on both sides is cleared to one',
    all.filter(t => t.time === '22:02').length === 1,
    JSON.stringify(all.map(t => `${t.time}:${t.direction}:${t.pnl}`)));
  check('the money it stood for is kept once',
    Math.abs(all.filter(t => t.time === '22:02').reduce((a, t) => a + t.pnl, 0) - 29.97) < 1e-9);
  check('a real trade at another time is untouched',
    all.filter(t => t.time === '09:49').length === 1, JSON.stringify(all.map(t => t.time)));
  check('so the day total loses only what was counted twice',
    Math.abs(all.reduce((a, t) => a + t.pnl, 0) - 29.57) < 1e-9,
    String(all.reduce((a, t) => a + t.pnl, 0)));
  // and it must stay cleared: the same two legs arrive again on the very next poll
  state.lqRows = [
    { time: '2026-09-09T22:02:11.000Z', asset: '#19310', side: 'sell', direction: '', size: '75',
      price: '1', fee: '0', closedPnl: '29.97', txHash: '0xrev' },
    { time: '2026-09-09T22:02:11.000Z', asset: '#19310', side: 'buy', direction: '', size: '75',
      price: '1', fee: '0', closedPnl: '29.97', txHash: '0xrev' },
  ];
  await page.waitForTimeout(7000);
  const resynced = await page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades);
  check('a poll that re-sends both legs does not put the twin back',
    resynced.filter(t => t.time === '22:02').length === 1,
    JSON.stringify(resynced.map(t => `${t.time}:${t.direction}:${t.pnl}`)));
  check('and the day is still counted once',
    Math.abs(resynced.reduce((a, t) => a + t.pnl, 0) - 29.57) < 1e-9,
    String(resynced.reduce((a, t) => a + t.pnl, 0)));

  check('no page errors clearing them', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.context().close();
}

// Hyperliquid answers with the code a market was deployed under and holds no display name to give
// instead. Nothing can derive one, so the name is whatever you say it is — and saying it has to
// reach the trades already recorded, not just the next ones.
async function liquidNaming(browser) {
  state = { orders: [], positions: [], lqRows: [
    { time: '2026-09-10T10:00:00.000Z', asset: 'xyz:CL', side: 'sell', direction: 'Close Long',
      size: '10', price: '95', fee: '0.5', closedPnl: '4', txHash: '0xn1' },
    { time: '2026-09-09T22:02:45.144Z', asset: '#19310', side: 'sell', direction: 'Close Long',
      size: '75', price: '1', fee: '0.105', closedPnl: '30.075', txHash: '0xn2' },
  ] };
  const { page, errs } = await openPage(browser);
  await page.evaluate(p => { const s = JSON.parse(localStorage.getItem('ledger:v4'));
    s.settings.liquidUrl = `http://localhost:${p}/liquid`; s.settings.liquidSecs = 5;
    localStorage.setItem('ledger:v4', JSON.stringify(s)); }, PORT);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.selectOption('#venue', 'liquid');
  await page.waitForTimeout(2000);
  const rows = () => page.evaluate(() => JSON.parse(localStorage.getItem('ledger:v4')).trades
    .map(t => ({ code: t.code, name: t.instrument, pnl: t.pnl, ref: t.reference })));

  const before = await rows();
  check('a code with no name given reads as the code', before.some(t => t.name === 'xyz:CL'),
    JSON.stringify(before.map(t => t.name)));
  check('and the raw code is kept alongside it', before.every(t => !!t.code), JSON.stringify(before));

  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(500);
  const listed = await page.evaluate(() => Array.from(document.querySelectorAll('[data-lqname]')).map(i => i.dataset.lqname).sort());
  check('Settings lists every code the book has traded',
    listed.includes('xyz:CL') && listed.includes('#19310'), JSON.stringify(listed));
  check('and the ones it only holds a position in', listed.includes('WTIOIL'), JSON.stringify(listed));

  await page.fill('[data-lqname="xyz:CL"]', 'WTIOIL');
  await page.fill('[data-lqname="#19310"]', 'Prediction market 1931');
  await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
  await page.waitForTimeout(600);

  const after = await rows();
  check('naming a code renames the trades already recorded',
    after.find(t => t.code === 'xyz:CL').name === 'WTIOIL', JSON.stringify(after.map(t => t.name)));
  check('including a prediction market',
    after.find(t => t.code === '#19310').name === 'Prediction market 1931');
  check('the money is untouched by a rename',
    after.reduce((a, t) => a + t.pnl, 0) === before.reduce((a, t) => a + t.pnl, 0),
    `${before.reduce((a, t) => a + t.pnl, 0)} -> ${after.reduce((a, t) => a + t.pnl, 0)}`);
  check('and so is the reference a row is keyed on',
    after.map(t => t.ref).sort().join('|') === before.map(t => t.ref).sort().join('|'));
  check('the table shows the name', /WTIOIL/.test(await page.evaluate(() => document.querySelector('#table').innerText)));

  // a position carries a code too, and renaming it must reach the open card
  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(500);
  await page.fill('[data-lqname="WTIOIL"]', 'Crude oil');
  await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-section="open"]').click());
  await page.waitForTimeout(500);
  check('renaming reaches the open position too',
    /Crude oil/.test(await page.evaluate(() => document.querySelector('#open').innerText)),
    await page.evaluate(() => (document.querySelector('#open').innerText || '').slice(0, 120)));

  // the next sync must keep the name, not overwrite it with the code again
  await page.waitForTimeout(7000);
  const synced = await rows();
  check('a later sync keeps the name rather than reverting to the code',
    synced.find(t => t.code === 'xyz:CL').name === 'WTIOIL', JSON.stringify(synced.map(t => t.name)));
  check('and adds nothing by renaming', synced.length === after.length, `${after.length} -> ${synced.length}`);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  check('the name survives a reload', (await rows()).find(t => t.code === 'xyz:CL').name === 'WTIOIL');

  // clearing it puts the code back, so a rename is never a one-way door
  await page.evaluate(() => document.querySelector('[data-act="settings"]').click());
  await page.waitForTimeout(500);
  await page.fill('[data-lqname="xyz:CL"]', '');
  await page.evaluate(() => document.querySelector('[data-act="save-settings"]').click());
  await page.waitForTimeout(600);
  check('clearing a name puts the code back', (await rows()).find(t => t.code === 'xyz:CL').name === 'xyz:CL');

  check('no page errors naming instruments', errs.length === 0, errs.slice(0, 2).join(' | '));
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
      ['live bar + TradingView', liveCandleAndTv], ['live bar over IG partial', livePartialBar],
      ['drawing tools', drawingTools],
      ['app-side stops', appSideStops], ['trailing stops', trailingStops],
      ['placing orders', placingOrders], ['breakeven stop', breakevenStop],
      ['averaging ladder', averagingLadder], ['market search', marketSearch],
      ['two positions on one market', multiPosition], ['liquid autosync', liquidSync],
      ['hyperliquid direct', hyperliquidDirect],
      ['liquid conversion edges', liquidEdges],
      ['liquid fill folding', liquidFillFolding], ['liquid fill migration', liquidFillMigration],
      ['liquid reversals', liquidReversals], ['liquid twin repair', liquidTwinRepair],
      ['liquid naming', liquidNaming],
      ['chart under polling', chartUnderPolling],
      ['venue isolation', venueIsolation], ['stops across venues', stopsAcrossVenues],
      ['order ticket chart', ticketChart]]) {
      if (process.env.ONLY && !label.includes(process.env.ONLY)) continue;
      process.stdout.write(`  ${label}… `);
      const before = results.length;
      try { await fn(browser); } catch (e) { check(`${label} suite crashed`, false, String(e.message || e).slice(0, 140)); }
      // A suite that threw never reached its own close, and a page left open keeps polling into
      // the shared call log — which then reads as a failure in whichever suite runs next.
      for (const c of browser.contexts()) await c.close().catch(() => {});
      const run = results.slice(before);
      console.log(`${run.filter(x => x.pass).length}/${run.length}`);
    }
  } finally { await browser.close(); srv.close(); }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('\nfailures:'); for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`); }
  process.exit(failed.length ? 1 : 0);
})();
