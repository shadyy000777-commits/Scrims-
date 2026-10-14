// Optional BGMI UID -> in-game name lookup (same unofficial Rooter endpoint
// the "bgmi-id-info" tool uses).
//
// THIS IS A SOFT CHECK. It can never block, delay for long, or crash a
// verification:
//   - every failure (blocked, rate limited, timeout, bad JSON, site down,
//     endpoint changed...) just means the UID comes back as "unverified"
//   - the whole batch has a hard deadline, so a slow Rooter can't hold the
//     verification form hostage
//   - after a few failures in a row a circuit breaker stops calling Rooter for
//     a few minutes, so a block/outage costs nothing per verification
//   - set UID_LOOKUP=off in .env to switch it off completely
//
// checkPlayerUids() NEVER throws and always returns one result per UID:
//   { status: 'match' | 'mismatch' | 'invalid' | 'unverified', name?: string }
//   'invalid'    = Rooter answered normally and said this UID doesn't exist
//   'unverified' = we couldn't tell (anything went wrong) -> always accepted
//
// "invalid" is only trusted while Rooter looks healthy. If it starts saying
// "invalid" to everything (a block disguised as an answer), the results are
// downgraded to 'unverified' so real players are never turned away:
//   - optional UID_LOOKUP_CANARY=<a real BGMI UID, e.g. yours>: when a UID comes
//     back invalid, the canary is checked too; if the canary fails, Rooter is
//     broken and the "invalid" is ignored
//   - always: 8 "invalid" answers in a row (no valid UID in between) pauses the
//     lookup for 5 minutes
//
// blockingProblems() lists what should stop a verification: invalid UIDs, and
// (only with UID_BLOCK_MISMATCH=on) IGNs that don't match the UID's name.

const TOKEN_URL = 'https://www.rooter.gg/';
const LOOKUP_URL = 'https://bazaar.rooter.io/order/getUnipinUsername';

const REQUEST_TIMEOUT_MS = 4000;   // per HTTP request
const BATCH_DEADLINE_MS = 6000;    // whole check for one team
const TOKEN_TTL_MS = 10 * 60 * 1000;
const NAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NAME_CACHE_MAX = 5000;
const BREAKER_THRESHOLD = 3;       // consecutive failures before pausing
const BREAKER_PAUSE_MS = 5 * 60 * 1000;

let token = null;
let tokenAt = 0;
let consecutiveFailures = 0;
let pausedUntil = 0;
let invalidStreak = 0;
const INVALID_STREAK_LIMIT = 8;
const nameCache = new Map(); // uid -> { name, at }

function enabled() {
  return String(process.env.UID_LOOKUP || 'on').trim().toLowerCase() !== 'off';
}

function recordFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    pausedUntil = Date.now() + BREAKER_PAUSE_MS;
    consecutiveFailures = 0;
    token = null;
    console.warn('[uid-lookup] Rooter lookup failing — pausing UID checks for 5 minutes (verifications are unaffected).');
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
  invalidStreak = 0;
}

async function fetchToken() {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  const res = await fetch(TOKEN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') cookies = res.headers.getSetCookie();
  else if (res.headers.get('set-cookie')) cookies = [res.headers.get('set-cookie')];
  const raw = cookies.map(c => /(?:^|[,\s])user_auth=([^;]+)/.exec(c)).find(Boolean);
  if (!raw) throw new Error('no user_auth cookie');
  const parsed = JSON.parse(decodeURIComponent(raw[1]));
  if (!parsed || !parsed.accessToken) throw new Error('no accessToken');
  token = parsed.accessToken;
  tokenAt = Date.now();
  return token;
}

// Returns the in-game name, or null when it can't be determined.
async function lookupName(uid) {
  const cached = nameCache.get(uid);
  if (cached && Date.now() - cached.at < NAME_CACHE_TTL_MS) return { name: cached.name };

  const accessToken = await fetchToken();
  const res = await fetch(`${LOOKUP_URL}?gameCode=BGMI_IN&id=${encodeURIComponent(uid)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Device-Type': 'web',
      'App-Version': '1.0.0',
      'Device-Id': 'scrims-bot',
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) token = null; // refetch next time
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const name = data && data.transaction === 'SUCCESS' && data.unipinRes && data.unipinRes.username;
  if (name && typeof name === 'string') {
    if (nameCache.size >= NAME_CACHE_MAX) nameCache.delete(nameCache.keys().next().value);
    nameCache.set(uid, { name, at: Date.now() });
    return { name };
  }
  // A well-formed JSON answer that says "not SUCCESS" = the UID doesn't exist.
  // Anything else (no transaction field, odd shape) = we can't tell.
  if (data && typeof data === 'object' && typeof data.transaction === 'string') return { invalid: true };
  return null;
}

// Is Rooter really healthy? Used before trusting an "invalid" answer.
async function rooterLooksHealthy() {
  const canary = String(process.env.UID_LOOKUP_CANARY || '').trim();
  if (!canary) return true; // no canary configured: rely on the streak guard
  try {
    const r = await lookupName(canary);
    return !!(r && r.name);
  } catch {
    return false;
  }
}

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

async function checkOne(ign, uid) {
  try {
    const r = await lookupName(uid);
    if (r && r.invalid) {
      invalidStreak += 1;
      if (invalidStreak >= INVALID_STREAK_LIMIT) {
        invalidStreak = 0;
        pausedUntil = Date.now() + BREAKER_PAUSE_MS;
        console.warn('[uid-lookup] Rooter says "invalid" to everything — pausing UID checks for 5 minutes (verifications are unaffected).');
        return { status: 'unverified' };
      }
      if (!(await rooterLooksHealthy())) return { status: 'unverified' };
      return { status: 'invalid' };
    }
    if (!r || !r.name) { recordFailure(); return { status: 'unverified' }; }
    recordSuccess();
    return { status: normalize(r.name) === normalize(ign) ? 'match' : 'mismatch', name: r.name };
  } catch (err) {
    recordFailure();
    return { status: 'unverified' };
  }
}

async function checkPlayerUids(igns, uids) {
  const unverified = () => uids.map(() => ({ status: 'unverified' }));
  try {
    if (!enabled() || Date.now() < pausedUntil) return unverified();

    // Warm the token once so the parallel lookups don't all fetch it.
    const work = (async () => {
      try { await fetchToken(); } catch { /* each lookup will report its own failure */ }
      return Promise.all(uids.map((uid, i) => checkOne(igns[i], uid)));
    })();
    const deadline = new Promise(resolve => setTimeout(() => resolve(null), BATCH_DEADLINE_MS));
    const results = await Promise.race([work, deadline]);
    if (!results) { recordFailure(); return unverified(); }
    return results;
  } catch (err) {
    return unverified();
  }
}

// "⚠️ P2 typed Soul, but UID 123 is registered as Soulz" lines for the
// mismatches only (empty array when everything matched or couldn't be checked).
function describeMismatches(igns, uids, checks) {
  const lines = [];
  (checks || []).forEach((c, i) => {
    if (c && c.status === 'mismatch') {
      lines.push(`P${i + 1} typed **${igns[i]}**, but UID ${uids[i]} is **${c.name}** in-game`);
    } else if (c && c.status === 'invalid') {
      lines.push(`P${i + 1}'s UID **${uids[i]}** wasn't found`);
    }
  });
  return lines;
}

// "P2: **Soul** → **Soulz**" lines for IGNs that were auto-corrected from the UID.
function describeCorrections(checks) {
  const lines = [];
  (checks || []).forEach((c, i) => {
    if (c && c.status === 'corrected') lines.push(`P${i + 1}: ~~${c.typed}~~ → **${c.name}**`);
  });
  return lines;
}

// Replaces typed IGNs with the in-game name when the UID's real name differs.
// Mutates `igns` and `checks` in place. Names too long for the form's limit are
// left as typed (and stay a plain mismatch warning).
function applyCorrections(igns, checks, maxLen = 30) {
  (checks || []).forEach((c, i) => {
    if (c && c.status === 'mismatch' && c.name && c.name.length <= maxLen) {
      checks[i] = { status: 'corrected', name: c.name, typed: igns[i] };
      igns[i] = c.name;
    }
  });
}

// What should STOP a verification (empty array = let it through).
function blockingProblems(igns, uids, checks) {
  const blockMismatch = String(process.env.UID_BLOCK_MISMATCH || 'off').trim().toLowerCase() === 'on';
  const lines = [];
  (checks || []).forEach((c, i) => {
    if (!c) return;
    if (c.status === 'invalid') {
      lines.push(`P${i + 1}: UID **${uids[i]}** doesn't exist — check it and try again`);
    } else if (blockMismatch && c.status === 'mismatch') {
      lines.push(`P${i + 1}: IGN **${igns[i]}** doesn't match UID ${uids[i]} (that UID is **${c.name}** in-game)`);
    }
  });
  return lines;
}

// Scrims verification helper: like blockingProblems + describeCorrections, but
// with real labels ("Player 3") instead of P1..Pn, since verification checks
// players in two separate steps.
//   -> { problems: string[] (stop the step), corrections: string[] (info) }
function reviewChecks(labels, igns, uids, checks) {
  const blockMismatch = String(process.env.UID_BLOCK_MISMATCH || 'off').trim().toLowerCase() === 'on';
  const problems = [];
  const corrections = [];
  (checks || []).forEach((c, i) => {
    if (!c) return;
    if (c.status === 'invalid') {
      problems.push(`**${labels[i]}** — UID **${uids[i]}** is wrong / doesn't exist`);
    } else if (c.status === 'mismatch' && blockMismatch) {
      problems.push(`**${labels[i]}** — IGN **${igns[i]}** doesn't match UID ${uids[i]} (that UID is **${c.name}** in-game)`);
    } else if (c.status === 'corrected') {
      corrections.push(`**${labels[i]}**: ~~${c.typed}~~ → **${c.name}**`);
    }
  });
  return { problems, corrections };
}
// Compact text for the Excel "ID Check" column.
function summarizeChecks(checks) {
  if (!checks || !checks.length) return '';
  return checks.map((c, i) => {
    if (!c || c.status === 'unverified') return `P${i + 1}: not checked`;
    if (c.status === 'match') return `P${i + 1}: OK`;
    if (c.status === 'invalid') return `P${i + 1}: UID NOT FOUND`;
    if (c.status === 'corrected') return `P${i + 1}: CORRECTED (typed ${c.typed})`;
    return `P${i + 1}: MISMATCH (${c.name})`;
  }).join(' | ');
}

// One-off in-game name lookup (for !verify). Returns the name or null; never throws.
async function lookupIgn(uid) {
  try {
    if (!enabled() || Date.now() < pausedUntil) return null;
    const r = await Promise.race([lookupName(String(uid)), new Promise(res => setTimeout(() => res(null), BATCH_DEADLINE_MS))]);
    return r && r.name ? r.name : null;
  } catch {
    return null;
  }
}

module.exports = { reviewChecks, applyCorrections, describeCorrections, lookupIgn, checkPlayerUids, describeMismatches, blockingProblems, summarizeChecks };
