# Ledger — a self-contained PnL trading dashboard

A single HTML file that turns broker exports into a proper trading review: equity curve,
heatmap calendar, R-multiples, session analysis, risk-rule adherence and confidence intervals.

No build step. No server. No account. Open the file and it works.

Live: <https://busayen.github.io/pnl/>

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Getting your data in](#getting-your-data-in)
- [The five sections](#the-five-sections)
- [Concepts worth understanding](#concepts-worth-understanding)
- [Settings reference](#settings-reference)
- [Optional: automatic sync with IG](#optional-automatic-sync-with-ig)
- [Privacy and security](#privacy-and-security)
- [Hosting your own copy](#hosting-your-own-copy)
- [How it is built](#how-it-is-built)
- [Adapting it to another broker](#adapting-it-to-another-broker)
- [Limitations](#limitations)

---

## What it does

Most trade journals tell you what you made. This one tries to tell you whether you have an edge,
and is deliberately cautious about claiming you do.

- **Overview** — KPIs with period-over-period deltas, equity curve with drawdown, heatmap calendar
  with weekly totals
- **Performance** — expectancy, profit factor, Sharpe, streaks, an "edge profile" radar, and
  breakdowns by month, weekday, hour, symbol, holding time and setup
- **Risk** — R-multiples, per-session risk caps, concurrent exposure, position sizing, capital
  consumed, Kelly and Monte Carlo, time- vs money-weighted return, outliers, rejected orders
- **Trends** — rolling win rate and profit factor, period comparisons, any two date ranges side by side
- **Trades** — sortable, searchable log with R per trade and inline setup tagging

It runs entirely in your browser. Data is stored in `localStorage` and never uploaded.

---

## Quick start

1. Open <https://busayen.github.io/pnl/> (or your own copy).
2. Click **Load demo trades** to see everything populated.
3. When you are ready, **Import** your own broker CSV.

That is the whole setup. Everything below is optional detail.

---

## Getting your data in

### From IG (best supported)

IG splits the information you need across two exports. Import **both** — the file type is
detected automatically, and order does not matter.

| Export | Found under | Gives you |
|---|---|---|
| **Transaction History** | My IG → Live accounts → History | P&L, size, open/close levels, deposits, fees |
| **Activity History** | My IG → Live accounts → History | Stop levels, order rejections, stop amendments |

Transaction History alone works fine, but **without Activity History there are no stop levels**,
so R-multiples and risk-rule checks stay blank. The app says so rather than showing zeros.

Activity files **accumulate** rather than replace, so you can layer several exports to cover a
longer history. Transaction imports **replace** everything, unless you choose
"Add as a separate account" in the review screen.

### From another broker

Any CSV with a **date** column and a **profit/loss** column will import. The parser recognises
many common header names and handles:

- currency symbols and thousands separators (`£1,234.50`, `(12.00)`, `1.234,56`)
- `DD/MM/YYYY` vs `MM/DD/YYYY`, auto-detected, overridable in Settings
- preamble rows above the real header
- comma, semicolon, tab and pipe delimiters

Optional columns unlock more: `instrument`, `direction`, `size`, `time`, `reference`,
open/close timestamps, `stop`, and open/close levels.

### By hand

**Add trade** in the header. Handy for positions that closed after your last export.

---

## The five sections

Switch with the tabs in the header, keys `1`–`5`, or `⌘K` / `Ctrl+K`.

The filter bar is global: timeframe, symbol, direction, account and setup apply to every section
at once.

---

## Concepts worth understanding

A few things behave in ways that are deliberate but not obvious.

### R-multiples

R is profit divided by the amount risked. A small win on a tight stop can beat a large win on a
wide one, and only R shows that.

Risk is derived from your **stop level at entry**, converted to account currency using the
trade's own realised result, so it works across instruments and currencies without an FX table.

### The "settled stop"

If you adjust stops after entry, which stop represents your real risk?

The rule: **the last stop amendment still on the losing side of entry that keeps at least 25% of
the original risk.** Later moves toward or past entry are banking profit, not defining risk. The
threshold is adjustable in Settings.

Why it matters: using the *final* stop breaks R entirely — a stop trailed past entry gives zero
or negative risk and R explodes to meaningless numbers. Using the *initial* stop is wrong too,
because a stop you widened or tightened before it was hit is the one that actually applied.

A useful sanity check: under this rule, every trade that exits at its stop should land at exactly
**−1.00R**. If yours do, the risk denominator is right.

### Sessions

A session is a unit of capital: a deposit, whatever trades follow, and the withdrawal that ends it.

By default a **new deposit starts a new session**, carrying any remaining balance forward as
`carried + deposit = capital`. Turn that off in Settings and deposits accumulate instead, with only
a withdrawal ending a session.

This matters if you fund per session rather than keeping a standing balance — daily P&L can look
positive on a day a session lost most of its capital.

### Risk rules

Rather than a fixed cash limit, the cap is a **percentage of that session's starting capital**, so
it rescales every time capital changes. At 50%, two full-size losses ends a session, and the loss
budget is derived automatically.

### Confidence intervals

Win rate, profit factor and expectancy show a 95% interval beside them — Wilson for the
proportion, bootstrap resampling for the rest.

This is the most important feature in the app. A win rate of 81% over 16 trades has an interval of
roughly 57–93%. The interval is the finding; the point estimate is not.

### Capital consumed

There is no fixed daily loss limit, because with guaranteed stops the deposit *is* the limit.
Instead the app reports how much of each session's capital was consumed at its worst point.

---

## Settings reference

| Setting | Effect |
|---|---|
| Currency symbol | Blank auto-detects from the data |
| Starting balance | Balance before the first row; enables % return and risk of ruin |
| Stop counts as risk above (%) | The settled-stop threshold, default 25 |
| Max risk per trade (% of session capital) | Risk-rule cap, default 50. Blank disables the check |
| Rolling window (trades) | For the rolling win-rate chart. Blank picks from sample size |
| Week starts on | Monday or Sunday |
| Calendar shading | Scale against all history or the visible month |
| Setup tags | Comma-separated; tag trades from the Trades table |
| Ambiguous dates | How to read `03/09/2026` |
| IG sync worker URL / token / range | See [sync](#optional-automatic-sync-with-ig) |
| Activity history files | Loaded files, each removable |
| Hide weekends | Drops Sat/Sun columns, overridden if a weekend has activity |
| A new deposit starts a new session | Session splitting behaviour |
| Include fees & funding in net P&L | Fees never count toward win rate either way |

Also here: **backup** (JSON, everything), **restore**, **read-only snapshot** (a self-contained HTML
file with data embedded), **print**, and **delete all**.

---

## Optional: automatic sync with IG

Skip this unless exporting CSVs annoys you. The numbers are identical either way.

A Cloudflare Worker holds your IG credentials and exposes one read-only endpoint the dashboard
calls. Your IG password never touches the browser.

```
Dashboard ──(sync token)──> Cloudflare Worker ──(IG credentials)──> IG REST API
```

### 1. Get an IG API key

My Account → Settings → API. Note that a standalone demo account generally cannot create one; the
demo must share an email with a live account.

**IG API keys are not read-only** — the same key can place trades. That is precisely why the
credentials live in the Worker rather than in the page. You can disable a key instantly from the
same screen.

### 2. Deploy the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker** → **Start with Hello
World!** → name it `ig-sync` → **Deploy** → **Edit code** → paste `ig-sync-worker.js` → **Deploy**.

Or with the CLI, from the folder containing `ig-sync-worker.js` and `wrangler.toml`:

```bash
npx wrangler login
npx wrangler deploy
```

### 3. Set the variables

Settings → Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `IG_BASE` | Text | `https://api.ig.com` (or `https://demo-api.ig.com`) |
| `ALLOW_ORIGIN` | Text | the exact origin of your dashboard |
| `IG_API_KEY` | Secret | your IG API key |
| `IG_USERNAME` | Secret | your IG login username |
| `IG_PASSWORD` | Secret | your IG password |
| `SYNC_TOKEN` | Secret | a long random string you invent |

`SYNC_TOKEN` is yours, not IG's. It stops strangers calling your endpoint, and it is the only
secret the browser ever holds — it can read history and nothing else.

### 4. Test

```
https://ig-sync.<subdomain>.workers.dev/health
https://ig-sync.<subdomain>.workers.dev/sync?from=2026-06-01&to=2026-09-06&token=YOUR_TOKEN
```

### 5. Point the dashboard at it

Settings → **IG sync worker URL** (no trailing `/sync`), **Sync token**, **Sync range**. Save, and a
**Sync** button appears in the header.

### Notes

- The Worker follows IG's paging, so long ranges return complete data.
- It automatically retries with an **encrypted password** when IG requires it. IG uses RSA
  PKCS#1 v1.5, which WebCrypto cannot do, so the padding is implemented directly in the Worker.
- Sync **replaces** your trades. Back up first if you have manual entries or setup tags.
- The sync range is a silent boundary — older trades simply will not appear.

---

## Privacy and security

- Everything runs client-side. Trades live in `localStorage` and are never uploaded.
- The page makes **no external requests**. Chart.js and html2canvas are inlined rather than pulled
  from a CDN, partly so that nothing third-party executes on a page that may hold a sync token.
- `localStorage` is scoped to the **origin**, not the path. Anything else you host under the same
  domain can read this data. Do not host untrusted code there.
- **Never commit** your exports, `ledger-backup-*.json`, or a read-only snapshot — those contain
  your full history. Suggested `.gitignore`:

```gitignore
*.csv
.env
ledger-backup-*.json
ledger-snapshot-*.html
pnl-calendar.png
```

Git keeps deleted files in history, so if one slips in, rewriting history or recreating the repo is
the only real fix.

---

## Hosting your own copy

GitHub Pages, free:

1. Create a public repo.
2. Add `index.html` at the root.
3. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Live at `https://<user>.github.io/<repo>/` in a minute or two.

Any static host works — Netlify, Cloudflare Pages, an S3 bucket, or just opening the file locally.
There is no build step because there is nothing to build.

---

## How it is built

One HTML file, roughly 620KB, containing:

| Layer | Role |
|---|---|
| **core** | CSV and JSON parsing, IG-specific classification, R and risk derivation, statistics |
| **analytics** | Sessions, exposure, sizing, rolling windows, Kelly, Monte Carlo, bootstrap CIs |
| **app** | State, rendering, charts, storage |
| **Chart.js 4.4.1** | Charts, inlined |
| **html2canvas 1.4.1** | Calendar PNG export, inlined |

Vanilla JavaScript. No framework, no bundler, no dependencies to install.

### Working on it

The published file is generated by concatenating sources. If you want to edit it, the practical
options are to edit `index.html` directly (search for `===== core =====` and similar markers), or
to split it back into `core.js` / `analytics.js` / `app.js` / `styles.css` and concatenate with a
short script.

The parsing and statistics layers are pure functions with no DOM access, so they can be tested
under Node directly.

### A note on testing

The risk logic was validated against real broker exports, not synthetic data — including a
cross-check that the CSV and JSON import paths produce identical R values to the cent. The RSA
implementation in the Worker was verified by decrypting its output with a real private key.

If you change the risk code, the −1.00R property is the cheapest regression test you have: any
trade exiting at its stop must come out at exactly −1R.

---

## Adapting it to another broker

Most of the work is in `core`:

1. **Column names** — add yours to the `COLS` vocabulary.
2. **Row classification** — `classify()` decides trade vs fee vs cash. IG-specific quirks live
   here, such as guaranteed-stop premiums (`CRPREM`) being booked with transaction type `WITH`
   despite being a fee, not a withdrawal.
3. **Stops** — R needs an entry level and a stop level per trade, plus amendments if you adjust
   stops. Supply them and everything downstream works unchanged.

---

## Limitations

- **Sample size is the real constraint.** The statistics are honest but cannot manufacture
  certainty. Under about 30 trades, most figures swing wildly and the confidence intervals will
  say so.
- No live prices, open positions, or streaming. It is a review tool, not a terminal.
- No tax-lot accounting or benchmark comparison.
- Storage is per browser, per device. Use backups to move data.
- Trades before your activity export's date range show no stop data, so no R.
- Only one currency at a time; multi-currency accounts are converted by the broker before import.

---

## Licence

MIT. No warranty. This is a personal analysis tool, not financial advice, and nothing it computes
is a recommendation to trade.
