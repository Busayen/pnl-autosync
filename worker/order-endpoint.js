/**
 * POST /order — the endpoint the dashboard's "New order" dialog calls.
 *
 * Drop this into your ig-sync worker alongside /close. It is written to match that file's shape:
 * it expects the helpers you already have there — `igLogin(env)` returning the CST and
 * X-SECURITY-TOKEN headers, and `json(body, status, env)` for CORS-carrying replies. Wire it into
 * your router next to the /close case.
 *
 * It needs one new secret, ORDER_TOKEN, deliberately separate from CLOSE_TOKEN. A leaked close
 * token can only shut positions; one that could also open them is a far larger blast radius, and
 * there is no reason for a single key to do both.
 *
 * VERIFY THE FIELD NAMES against IG's current REST reference before trusting this with money. The
 * shapes below follow IG's v2 deal endpoints as documented, but this file has never run against a
 * live account — it was written from the documentation, not from a successful fill. Try it on a
 * demo account first.
 *
 *   Market order      POST /gateway/deal/positions/otc       Version: 2
 *   Working order     POST /gateway/deal/workingorders/otc   Version: 2
 *   Confirmation      GET  /gateway/deal/confirms/{dealRef}  Version: 1
 */

// Replays are the thing to fear here: a retried open is a doubled position, not a no-op. Deal
// references are remembered for an hour so the same idempotencyKey can never place twice.
// Worker instances are not shared, so this is a best-effort guard against a retrying client, not
// a distributed lock — put it in KV if you want it to hold across instances.
const seen = new Map();
const REPLAY_WINDOW_MS = 60 * 60 * 1000;
function rememberKey(key, value) {
  const now = Date.now();
  for (const [k, v] of seen) if (now - v.at > REPLAY_WINDOW_MS) seen.delete(k);
  seen.set(key, { at: now, value });
}

export async function handleOrder(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, env);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Refuse outright if the secret was never set, rather than becoming a worker that accepts
  // everything because a variable is missing.
  if (!env.ORDER_TOKEN || token.length !== env.ORDER_TOKEN.length ||
      ![...token].every((c, i) => c === env.ORDER_TOKEN[i])) {
    return json({ error: 'Unauthorized' }, 401, env);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400, env); }
  const { epic, direction, size, orderType, level, stopDistance, limitDistance, idempotencyKey } = body || {};

  if (!epic || !['BUY', 'SELL'].includes(direction)) return json({ error: 'epic and direction are required' }, 400, env);
  const qty = Number(size);
  if (!isFinite(qty) || qty <= 0) return json({ error: 'size must be a positive number' }, 400, env);
  if (!['MARKET', 'LIMIT'].includes(orderType)) return json({ error: 'orderType must be MARKET or LIMIT' }, 400, env);
  if (orderType === 'LIMIT' && !(Number(level) > 0)) return json({ error: 'a LIMIT order needs a level' }, 400, env);
  if (!idempotencyKey) return json({ error: 'idempotencyKey is required' }, 400, env);

  // An optional ceiling, so a fat-fingered size cannot get through even if the page lets it.
  const maxSize = Number(env.MAX_ORDER_SIZE || 0);
  if (maxSize > 0 && qty > maxSize) return json({ error: `size ${qty} is over MAX_ORDER_SIZE (${maxSize})` }, 400, env);

  const prior = seen.get(idempotencyKey);
  if (prior) return json(prior.value, 200, env);          // same key, same answer, no second order

  const headers = await igLogin(env);
  const base = env.IG_BASE || 'https://api.ig.com';
  const market = orderType === 'MARKET';
  const url = `${base}/gateway/deal/${market ? 'positions' : 'workingorders'}/otc`;
  const common = {
    epic, expiry: '-', direction, size: qty, guaranteedStop: false, forceOpen: true,
    currencyCode: env.IG_CURRENCY || 'GBP',
    ...(Number(stopDistance) > 0 ? { stopDistance: String(stopDistance) } : {}),
    ...(Number(limitDistance) > 0 ? { limitDistance: String(limitDistance) } : {}),
  };
  const payload = market
    ? { ...common, orderType: 'MARKET' }
    : { ...common, level: Number(level), type: 'LIMIT', timeInForce: 'GOOD_TILL_CANCELLED' };

  const placed = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json; charset=UTF-8', Version: '2' },
    body: JSON.stringify(payload),
  });
  const placedBody = await placed.json().catch(() => null);
  if (!placed.ok || !placedBody || !placedBody.dealReference) {
    return json({ error: (placedBody && (placedBody.errorCode || placedBody.error)) || `IG returned ${placed.status}` }, 502, env);
  }

  // A dealReference means IG accepted the *request*, not the deal. Only the confirmation says
  // whether anything actually happened, and the dashboard never claims success before it arrives.
  const conf = await fetch(`${base}/gateway/deal/confirms/${encodeURIComponent(placedBody.dealReference)}`, {
    headers: { ...headers, Accept: 'application/json; charset=UTF-8', Version: '1' },
  });
  const confirm = await conf.json().catch(() => null);
  if (!conf.ok || !confirm) {
    const out = { dealStatus: 'UNCONFIRMED', dealReference: placedBody.dealReference,
                  reason: 'IG accepted the request but did not confirm it. Check the IG app before retrying.' };
    rememberKey(idempotencyKey, out);
    return json(out, 200, env);
  }

  const out = {
    dealStatus: confirm.dealStatus === 'ACCEPTED' ? 'ACCEPTED' : (confirm.dealStatus || 'REJECTED'),
    dealReference: placedBody.dealReference,
    dealId: confirm.dealId || null,
    level: confirm.level ?? null,
    reason: confirm.reason || null,
  };
  rememberKey(idempotencyKey, out);
  return json(out, 200, env);
}
