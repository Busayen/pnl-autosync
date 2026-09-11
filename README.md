# Ledger — a self-contained PnL trading dashboard

README is not updated to the latest version 

A single HTML file that turns broker exports into a proper trading review: equity curve,
heatmap calendar, R-multiples, session analysis, risk-rule adherence and confidence intervals.

No build step. No server. No account. Open the file and it works.

Live: <https://busayen.github.io/pnl-autosync/>

---

The version the page is running is shown in Settings and on hover over the Ledger mark, so
"is the copy online the current one?" is answerable from the page rather than from a commit log.

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Getting your data in](#getting-your-data-in)
- [The five sections](#the-five-sections)
- [Concepts worth understanding](#concepts-worth-understanding)
- [Placing orders](#placing-orders)
- [App-side stops](#app-side-stops)
- [Settings reference](#settings-reference)
- [Optional: automatic sync with IG](#optional-automatic-sync-with-ig)
- [Privacy and security](#privacy-and-security)
- [Hosting your own copy](#hosting-your-own-copy)
- [Testing](#testing)
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

1. Open <https://busayen.github.io/pnl-autosync/> (or your own copy).
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

## Two books: IG and Liquid

The dropdown beside the Ledger mark switches the whole dashboard between two accounts. They share
nothing — separate trades, separate calendar, separate statistics, separate filters, separate
everything. Netting them would make every number on the page meaningless: different broker,
different currency, and one of them is leveraged perpetuals.

Switching away stores the book you left; switching back restores it exactly. Both are saved.

The **Risk** tab is not offered on Liquid. It is built on stop levels and session capital, and a
perpetuals venue reports neither, so it could only ever be blank.

### Getting Liquid data in

Liquid runs on Hyperliquid, and this page is static with no credentials for it, so the data arrives
the way everything else here does: you paste it. **Paste Liquid data** takes either blob, or both:

- the **portfolio** blob (`account` and `positions`) → open positions, equity, margin
- the **history** blob (`rows`) → realised P&L

Positions replace what is there. Fills are merged, and a fill already imported is skipped rather
than counted twice.

A fill is not a trade. Only the closing half has a result — and Liquid reports that result exactly,
so the entry behind it is *recovered* rather than guessed: `closedPnl = (close − open) × size` for a
long, and the mirror for a short. Two closes off the same entry both resolve to the same open price,
which is how you know it is right. Each closed trade is recorded net of its closing fee; an opening
fill has no result yet but its fee is already paid, so that lands on its own day as a cost.

**Only a close is a trade.** Hyperliquid stamps every fill with a realised P&L — `0.0` on the ones
that opened a position — so the field being present is not the signal; money having been realised
is. And reversing a position closes one side and opens the other in one stroke: a venue that reports
that as two rows puts the same realised P&L on both halves, and taking the opening half at its word
books the trade a second time on the opposite side. Only the half that closed realised anything.

**One order is one trade, however many fills it took.** A market close eats several levels of the
book and Hyperliquid reports each level separately — three rows for one exit is ordinary. Fills
matched in the same block carry that block's hash, so they are folded back into the order they came
from: sizes summed, the close size-weighted to the price the order actually got, and the entry
recovered from the totals. Because every fill of an order closes against the same average entry,
that arithmetic is exact — folding the two real fills below returns 95.104, the same entry either
one recovers alone. A folded row is marked with how many fills it took.

This matters beyond tidiness. Win rate, average win and loss, expectancy and the R distribution are
all per trade. Left unfolded, one exit counts three times, and a leg where the price never moved
counts as a loss the size of its fee — which is how a profitable day reads as a losing one.

Positions are a mirror of what Liquid shows. Nothing in this app can open, close or change one —
those live on Liquid.

### Autosync

Set a **Liquid wallet address** in Settings and the pasting stops. Hyperliquid's info endpoint is
public — it takes an address and nothing else, no key — which is the only reason a page holding no
secrets can read the account at all. No worker route is needed for this.

Whether a browser is *allowed* to call it depends on Hyperliquid's CORS headers. If it is refused,
the sync says so on the card rather than looking fine, and a proxy solves it: put a **Liquid sync
URL** in Settings instead and it takes precedence over the address.

The **builder prefix** matters. Positions like `xyz:CL-PERP` are builder-deployed, so the `dex`
field must be sent; without it Hyperliquid answers for its main perp dex and returns nothing. If
positions come back empty while Liquid shows one, that is the field to suspect.

The address is public on-chain data, but it names whoever holds the page, so it is stripped from
snapshots and backups along with the tokens.

A sync URL works the same way and accepts anything answering with Liquid's shapes. Anything that answers with those same
shapes will do — a worker route, a proxy, anything. The page holds no Liquid credentials of its
own; the URL is the whole contract, and an optional token is sent as a bearer if your endpoint
wants one.

It polls only while the Liquid book is open and the tab is visible: nothing here is armed to act,
so a hidden tab has no reason to keep asking. Fifteen seconds is the default and is plenty —
positions move with the price, realised history barely changes. A fill already imported is skipped,
so polling the same window forever adds nothing.

A failing endpoint is reported on the card rather than left to look live, backs off rather than
being hammered, keeps what it already had, and recovers on its own when the endpoint does.

The URL and its token are treated as secrets exactly like IG's: stripped from snapshots and
backups, and never written into an export.

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

## Placing orders

**New order** on the Open section opens a position on IG: **Market** fills now, **Limit** rests
until the price trades at your level. Both take an optional stop and target distance.

### Finding the instrument

The instrument field searches by name, not by code. Type `dow mini`, `nasdaq`, `gbpjpy` — the words
can be in any order, and it matches the market name, its common alias, the contract variant and the
epic itself. Pick a row and the epic goes in.

Three sources, in order, and the difference matters:

- **Traded on this account** — from your own positions, working orders and closed trades. Listed
  first, tagged, and true by construction: the account has dealt them.
- **From IG** — live market search, when your worker offers `GET /markets?q=`. This reaches
  everything the account can trade, with IG's own instrument type and expiry shown beside each
  result, which is what actually tells one contract from another. Debounced, cached for five
  minutes, and it counts against IG's ordinary per-minute request limit, **not** the weekly
  historical price allowance that candles spend.
- **The built-in list** — the main index futures (standard and mini) and FX majors, used when live
  search is unavailable. A starting point, **not checked against your account**. IG varies epics by
  region and account type, and its own mini suffix is inconsistent: most are `IFM`, but Dow, DAX
  and CAC are `IMF`. A wrong epic is refused with a plain error rather than doing anything strange,
  but it is refused.

A worker without the endpoint returns 404, the picker falls back to the built-in list, and it is
not asked again for the rest of the session. Nothing breaks; you just get twenty markets instead of
all of them.

You can still paste an epic straight in; the field takes anything.

The ticket carries the chart for the instrument on its left, with your entry, stop and target drawn
on the price as you type them, so you can see the trade before you send it. `TV` adds a TradingView
chart under it. Naming an instrument is what loads the chart — each new timeframe costs 150 of IG's
weekly data points, so it does not fetch on every keystroke.

**This needs a `POST /order` handler on your worker.** The worker source is kept outside this repo,
so nothing here can be deployed by accident; the endpoint must exist there or the button fails.

It uses **its own secret**, `ORDER_TOKEN`, separate from `CLOSE_TOKEN`. A leaked close token can
only shut positions; one that could also open them is a far larger blast radius, and nothing is
gained by making one key do both. The worker should refuse to run if the three tokens are not
distinct.

Limits belong on the worker, not in this page, because that is the only place they cannot be
bypassed by whatever is calling:

| Worker variable | Effect |
|---|---|
| `IG_CURRENCY` | Required. Must match the account, e.g. `SGD`. |
| `REQUIRE_STOP` | Defaults to requiring a stop on every order. `false` permits naked ones. |
| `GUARANTEED_STOP` | Defaults to guaranteed stops. `false` places ordinary ones. |
| `MAX_ORDER_SIZE` | Ceiling on size. |
| `MAX_RISK_POINTS` | Ceiling on stop distance. |

The worker also wants a `GET /markets?q=` endpoint for instrument search. It is read-only and sits
behind `SYNC_TOKEN`; without it the order ticket falls back to its built-in list of epics.

The dashboard refuses a size above 10,000 before sending, but that is a typo guard, not a risk
limit — `MAX_ORDER_SIZE` is the one that counts. The form marks the stop as required because that
is the worker's default; if you set `REQUIRE_STOP=false` the field is genuinely optional.

How failures are handled, which is the part worth knowing:

- The order is only called placed when **IG confirms** it, never on the request returning 200.
- A **rejection** (insufficient funds, market closed) changed nothing, so it is shown and you can
  try again.
- An order IG **did not confirm** blocks the retry button, because a second attempt would double
  the position. Check the IG app before doing anything else.
- The idempotency key is minted per dialog, and the worker should refuse a repeat of the same key
  for an hour. Note that a Workers in-memory guard is per-isolate: it stops a double click, not two
  requests that happen to land on different isolates. The button disabling itself while a request
  is in flight is the first line of defence, not the worker.

---

## App-side stops

IG refuses a stop closer than its own minimum distance from the price. **Stop** on an open position
sets one here instead: the tab watches the price and sends the same close order the Close button
sends when your level is reached.

Understand what it is not. It runs **in this browser tab**, so it cannot act when the tab is shut,
the machine is asleep, the network is down, or the market gaps straight through the level. A
background tab keeps watching but browsers throttle it to roughly once a minute, so the fill can be
well past your level. It sends a market order, so it slips like any other.

Reading the other book is not the same as shutting the tab: an armed stop is still watched from the
Liquid side, because it was armed against a real position. Nothing else about IG is polled there.

It is a convenience on top of a broker stop, **never a replacement for one**.

### Fixed, breakeven, or trailing

A **fixed** stop sits at the price you name. **Breakeven** fills in your entry price for you — one
click rather than reading it off the row and retyping it. Note it is breakeven on the *level*, not
on the money: you still pay the spread, so a position closed there is a touch down, not exactly
flat. It is only reachable while the position is in front. From behind, your entry sits through the
price, so it would fire the instant it armed — the dialog says so and refuses to arm it.

A **trailing** stop sits a distance behind the best
price the tab has seen and ratchets one way only — up for a long, down for a short — never giving
ground.

Trailing is the weaker of the two, for a reason worth understanding. A fixed stop only suffers
detection lag: the level is known, so the error is however far price travels past it between polls.
A trailing stop also *derives* its level from the highest price it has observed, and polling can
only ever see a high at or below the real one. So the anchor sits low and the detection is late,
and the two compound. An app-side trail is therefore always looser than a broker's, never tighter.
The armed panel shows the anchor it is working from, so you can see what it has actually seen.

Practicalities:

- It needs a **close token saved in Settings**, or it can arm but never fire. The dialog says so.
- The idempotency key is minted when you arm and reused on every attempt, so a retry after a
  timeout cannot become a second close.
- If IG **rejects** the close it is reported and not retried. If IG **does not confirm**, it stops
  and tells you to check the IG app — the order may have filled.
- Closing the position any other way removes the stop.

---

## Averaging ladder

A planned, bounded scale-in. Arm it on an open position and it adds to that position as it goes
against you, on a fixed schedule, with every entry sharing one broker stop.

The schedule is three entries: the position you already have, one at 0.2R against you at 1.5&times;
the size, and one at 0.5R against you at 2.25&times;. R is the position's own risk — the distance
from its entry to its broker stop — so a rung "at 0.2R" is a fifth of the way to that stop.

**Read this table before using it.** Adding to a loser inverts your risk:

| Entry | Goes on at | Size | Loses at the shared stop |
|---|---|---|---|
| the position | already on | 1.00x | 1.000R |
| rung 1 | −0.2R | 1.50x | 1.200R |
| rung 2 | −0.5R | 2.25x | 1.125R |
| | | **4.75x** | **3.325R** |

A position risking £100 becomes a ladder risking £332.50. The average entry ends up 0.3R below the
original, so a small bounce takes the whole stack green — and the stop, when it comes, costs 3.3
times what the position alone would have. On those numbers the ladder has to be right **77.8%** of
the time to break even against a +0.2R exit. That is the trade. It is not a way of being right more
often; it is a way of being wrong more expensively, less often.

### What holds it

The cap is on **money, not rungs**. A rung count silently means whatever the scaling makes it mean;
a money cap means what it says. You type the most you are willing to lose, and before every entry
the ladder recomputes what the stack would lose at the shared stop — counting rungs already filled
at the price they *actually* filled, not the price that was planned. A rung that would push it past
the cap does not go on, and the ladder stops there and says so.

That last detail matters after a gap. If price jumps through a trigger the rung fills well past it,
which makes the stack cost more at the stop than the plan said. The cap sees the real fills, so a
bad fill brings the ladder up against it sooner.

### Shadow mode

A new ladder arms in **shadow mode** by default, and you should leave it there for a while.

It runs the entire engine — same triggers, same money cap recomputed from live numbers, same one
rung per poll — and sends nothing. Each rung is recorded where it *would* have gone on, at the
price it would have got, and the row shows `shadow 1/2` instead of `ladder 1/2`. Nothing in this
app has ever placed an order against a real account; the field names in the worker's `/order` come
from IG's documentation rather than from a successful fill. Finding out with money is the expensive
way round.

A shadow ladder needs no order token and does not ask you to sign off on the risk. Both are the
price of going live: untick shadow and the dialog asks for the token and the acknowledgement.

### The rest of the guardrails

- **Every rung carries a broker stop** aimed at the shared level, so the stack is protected with
  this tab shut. Adding needs the tab open, which fails safe: a closed tab means no more entries,
  never an unguarded stack. IG measures a stop from the fill, so rungs land near the shared price,
  not exactly on it.
- **No broker stop on the position, no ladder.** There is no R to measure against and no shared
  level to put underneath. The dialog refuses to arm.
- **No value per point, no ladder** either — the money cap could not be computed, and a ladder
  without that cap is not one this app will arm.
- **One rung per poll**, each with an idempotency key fixed to that rung, so a retry after a
  timeout cannot become a second entry.
- **Any rejection stops the whole ladder.** It does not retry into a moving market. An unconfirmed
  entry stops it too, and tells you to check the IG app.
- It uses the same `ORDER_TOKEN` as the order ticket. Without one, a rung comes due and nothing is
  sent — the ladder errors rather than half-running.
- Removing a ladder leaves any entries it already placed alone. They are ordinary positions.

The last rung sits 0.5R from its stop. If that is inside IG's minimum stop distance for the market,
the entry is refused and the ladder stops there.

---

## The chart

Click a symbol in the open positions table to chart it. Candles come from IG once per timeframe per
session and are cached; the bar in progress is driven by the position feed, which is already running
and costs nothing.

IG stamps a bar with the start of its interval and hands back the one still forming, so its newest
candle is usually a partial. Because candles are bought once, that partial would otherwise sit
frozen until the interval rolled. The chart takes it over instead — keeping the open, high and low
IG has already recorded for the interval, and moving the close with the live price — so the newest
candle grows the way it does on a real charting package. It updates as fast as the position poll,
so a couple of seconds, not tick by tick.

The time axis is a fractional index rather than a category, so it pans on parts of a candle rather
than jumping one at a time, and it scrolls forward until only a couple of candles are left on
screen — most of a pane's worth of empty space to plan into, and more the further you zoom out.

| Gesture | Effect |
|---|---|
| Scroll over the chart | Zoom time around the pointer |
| Scroll over the price scale (or hold Shift) | Zoom price |
| Drag the chart | Pan both axes; a flick coasts |
| Sideways scroll or two-finger swipe | Pan time. Never handed to the page, so it cannot scroll the screen out from under you |
| Drag the price or time scale | Stretch that axis |
| Double-click | Back to the default window |
| Pinch | Zoom both axes |

`Fit` restores that default, `All` shows every candle, and `Levels` reframes the price around your
entry, stop and target.

### More than one position on a market

Opening a chart shows **every** position on that instrument, not just the one you clicked. Two
entries on one market are one exposure, and reading them on separate charts is how you misjudge it.

Each leg draws its own line, labelled with its side, size and running P&L. When they are all the
same way round, a dashed **average cost** line is drawn too, weighted by size, carrying the total
for the instrument. A stop both legs share is drawn once; different targets are both kept.

Labels sit in the price gutter, right of the plot, so a level can never end up on top of a candle
whatever you do with the pan. The gutter widens to fit the longest label and is capped at a third
of the chart, so a phone keeps most of its price action.

### Drawing tools

The rail down the left of the chart holds a horizontal line, a trend line, a ray, a box, a
Fibonacci retracement, and a **trade planner** — the long/short tool that shades the profit zone in
your profit colour and the risk zone in your loss colour, straight from whichever palette is set in
Settings, and prints the reward-to-risk.

Pick a tool, drag on the chart. Pick it again to go back to the cursor. With the cursor, click a
drawing to select and move it, drag its handles to reshape it, and press Delete to remove it. The
bin at the foot of the rail clears the market.

Drawings are anchored to **time and price**, not to a candle index, so they stay put as new candles
arrive and when you change timeframe. They are saved per instrument, in your browser, alongside
everything else.

They are notes to yourself. Nothing on the chart places, moves, or closes anything — an app-side
stop is the only drawing-adjacent thing that acts, and you arm that from the **Stop** button.

### TradingView alongside

`TV` puts a TradingView chart under the built-in one, on a second feed, so the prices will not
match IG exactly. It is the only thing in the app that loads someone else's code, it is off by
default, and it runs in a cross-origin frame that cannot reach the tokens this page holds.
`Draw` inside that panel turns on TradingView's own drawing toolbar; those drawings live inside
their frame, not in this app, and are not saved unless you are signed in to TradingView.

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
- The page makes **no external requests** by default. Chart.js and html2canvas are inlined rather
  than pulled from a CDN, partly so that nothing third-party executes on a page that may hold a
  sync token.
- The one exception is opt-in: the **TV** button on a position chart embeds TradingView. It is off
  until you press it, and it loads in a cross-origin `<iframe>` — TradingView runs on its own
  origin and cannot read the sync or close token this page keeps in `localStorage`. Its prices come
  from a different feed than IG's, so the two charts will not agree tick for tick. Leave it off if
  you would rather the page stay entirely self-contained.
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

## Testing

Two harnesses drive a real Chromium against the file.

```sh
npm i -D playwright && npx playwright install chromium
node test/stress.js      # parsing, injection, exports, layout, palette, storage, a11y
node test/live.js        # positions, orders, closing, FX, the candle chart on desktop and phone
```

`live.js` stands up a mock IG worker on the page's own origin, so the fetch/render/close/chart
path is exercised end to end without touching a real account. Both take an optional path
argument, exit non-zero on failure and name each one. Worth running against any new version
before publishing it.

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
