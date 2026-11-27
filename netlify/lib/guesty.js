// Guesty Booking Engine API client for Netlify Functions. Never import this from browser code.
// Docs of record: booking-api-docs.guesty.com (Authentication, Access token management, API Intro).
// Endpoint paths follow the API reference, server https://booking.guesty.com/.
//
// Token rules from those docs: a token lives 24 hours (expires_in 86400). The Authentication page says
// "Tokens can only be renewed 3 times in 24 hours" and also gives a quota (ratelimit-limit) of 5, with
// ratelimit-remaining and ratelimit-reset (seconds until a used slot regenerates) on the token reply.
// This client takes the lower figure:
// - every token REQUEST (not every success) is written to a shared rolling 24-hour allowance in the
//   Blobs store BEFORE it is sent, so a lost reply, a timeout or a failed write after Guesty issued a
//   token still counts; both functions share the allowance;
// - a lower ratelimit-remaining from Guesty, until its reset, lowers the allowance further;
// - one lease entry lets only one instance at a time ask for a token, and failures back off.
// When the allowance is spent the site serves the Airbnb fallback until a slot frees up.
//
// The store is site-wide, and Netlify lets build plugins read every store on a site. So the cached
// token is never stored in the clear: it is sealed with AES-256-GCM under a key derived from
// GUESTY_BE_CLIENT_SECRET, which is scoped to Functions only. A reader without that secret gets
// nothing usable.
import {createCipheriv, createDecipheriv, hkdfSync, randomBytes} from 'node:crypto';

export const TOKEN_URL = 'https://booking.guesty.com/oauth2/token';
export const API_BASE = 'https://booking.guesty.com';

export const TOKEN_ALLOWANCE = 3;        // Token requests per rolling 24 hours (the docs' lower figure).
const DAY = 24 * 3600e3;
const REFRESH_EARLY_MS = 5 * 60e3;       // Guesty's recipe: renew 5 minutes before expiry.
const MIN_TOKEN_GAP_MS = 8 * 3600e3;     // After a success, no new token for 8 hours.
const CLAIM_MS = 60e3;                   // How long one instance holds the right to request a token.
const HOUR = 3600e3;
const SEAL_INFO = 'stay-eden guesty token cache v1';

export class GuestyUnavailable extends Error {
  constructor(status) {
    super(status);
    this.status = status;
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function headerSeconds(res, names) {
  for (const name of names) {
    const raw = (res.headers.get(name) || '').trim();
    if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  }
  return null;
}

// Retry-After is delta-seconds or an HTTP date (RFC 9110). Returns milliseconds, or null.
function retryAfterMs(res, now) {
  const raw = (res.headers.get('retry-after') || '').trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const date = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(date)) return Math.max(0, date - now);
  const reset = headerSeconds(res, ['ratelimit-reset']);
  return reset ? reset * 1000 : null;
}

// How long to wait before the next token request after a failure.
export function tokenBackoffMs(status, failures, res) {
  if (status === 429) {
    const seconds = res && headerSeconds(res, ['retry-after', 'ratelimit-reset']);
    return clamp(seconds ? seconds * 1000 : HOUR, 15 * 60e3, 24 * HOUR);
  }
  if (status === 400 || status === 401 || status === 403) return Math.min(HOUR * 2 ** failures, 24 * HOUR);
  return Math.min(2 * 60e3 * 2 ** failures, HOUR);
}

// Seal and open the cached token. The key comes from the client secret, so only code that holds the
// secret (the functions) can read the token back; GCM refuses any record that was altered.
export function sealKey(clientId, clientSecret) {
  return Buffer.from(hkdfSync('sha256', clientSecret, 'stay-eden:' + clientId, SEAL_INFO, 32));
}
export function sealToken(token, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(SEAL_INFO + ':' + token.expiresAt));
  const ct = Buffer.concat([cipher.update(token.accessToken, 'utf8'), cipher.final()]);
  return {v: 1, expiresAt: token.expiresAt, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64')};
}
export function openToken(record, key) {
  if (!record || record.v !== 1 || !Number.isFinite(record.expiresAt)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(SEAL_INFO + ':' + record.expiresAt));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const accessToken = Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]).toString('utf8');
    return accessToken ? {accessToken, expiresAt: record.expiresAt} : null;
  } catch {
    return null;
  }
}

// The rolling allowance: attempts in the last 24 hours, plus Guesty's own count when it sent one.
export function allowanceLeft(record, now) {
  const attempts = (record && Array.isArray(record.attempts) ? record.attempts : []).filter(t => Number.isFinite(t) && now - t < DAY);
  let left = TOKEN_ALLOWANCE - attempts.length;
  const guesty = record && record.guesty;
  if (guesty && Number.isFinite(guesty.remaining) && Number.isFinite(guesty.at) && Number.isFinite(guesty.resetAt) && now < guesty.resetAt) {
    left = Math.min(left, guesty.remaining - attempts.filter(t => t > guesty.at).length);
  }
  return {left, attempts};
}

/**
 * store: a Netlify Blobs store (get, getWithMetadata, setJSON with onlyIfNew / onlyIfMatch).
 * memo: an object that outlives one invocation (module scope in the function file).
 */
export function createGuesty({clientId, clientSecret, store, fetch, now = Date.now, memo = {}, timeoutMs = 4000}) {
  if (!clientId || !clientSecret) throw new GuestyUnavailable('not_configured');
  const key = sealKey(clientId, clientSecret);

  async function stored(op) {
    try { return await op(); } catch { throw new GuestyUnavailable('store_error'); }
  }

  // A deadline we own and clear, so the pending timer keeps the request alive until it fires.
  async function send(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Guesty did not answer in time', 'TimeoutError')), timeoutMs);
    try {
      return await fetch(url, {...init, signal: controller.signal});
    } catch (error) {
      const name = error && error.name;
      throw new GuestyUnavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  const fresh = token => Boolean(token && typeof token.accessToken === 'string' && now() < token.expiresAt - REFRESH_EARLY_MS);
  const readToken = async () => openToken(await stored(() => store.get('token', {type: 'json'})), key);

  // Record Guesty's own count of token slots left; best effort, the attempt is already counted.
  async function noteGuestyQuota(res) {
    const remaining = Number.parseInt(res.headers.get('ratelimit-remaining') || '', 10);
    const reset = headerSeconds(res, ['ratelimit-reset']);
    if (!Number.isFinite(remaining) || !reset) return;
    const at = now();
    try {
      const current = await store.getWithMetadata('token-issuance', {type: 'json'});
      const data = {...(current && current.data), guesty: {remaining, at, resetAt: at + reset * 1000}};
      await store.setJSON('token-issuance', data, current ? {onlyIfMatch: current.etag} : {onlyIfNew: true});
    } catch { /* the pre-request record stands */ }
  }

  async function requestToken() {
    const lease = await stored(() => store.getWithMetadata('token-lease', {type: 'json'}));
    const state = (lease && lease.data) || {};
    if (state.until && now() < state.until) {
      // Another instance may have just stored a token; use it rather than waiting.
      const latest = await readToken();
      if (fresh(latest)) return (memo.token = latest);
      throw new GuestyUnavailable('token_backoff');
    }
    const issuance = await stored(() => store.getWithMetadata('token-issuance', {type: 'json'}));
    const {left, attempts} = allowanceLeft(issuance && issuance.data, now());
    if (left <= 0) throw new GuestyUnavailable('token_allowance');

    const failures = Number.isInteger(state.failures) ? state.failures : 0;
    const claim = await stored(() => store.setJSON('token-lease', {until: now() + CLAIM_MS, failures},
      lease ? {onlyIfMatch: lease.etag} : {onlyIfNew: true}));
    if (!claim || !claim.modified) throw new GuestyUnavailable('token_busy');
    // Count the attempt before it is sent. If this write does not land, nothing is sent.
    const counted = await stored(() => store.setJSON('token-issuance',
      {...(issuance && issuance.data), attempts: [...attempts, now()]},
      issuance ? {onlyIfMatch: issuance.etag} : {onlyIfNew: true}));
    if (!counted || !counted.modified) throw new GuestyUnavailable('token_busy');

    const fail = async (status, res) => {
      await stored(() => store.setJSON('token-lease', {until: now() + tokenBackoffMs(res ? res.status : 0, failures, res), failures: failures + 1}));
      throw new GuestyUnavailable(status);
    };

    let res;
    try {
      res = await send(TOKEN_URL, {
        method: 'POST',
        headers: {accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'client_credentials', scope: 'booking_engine:api', client_id: clientId, client_secret: clientSecret})
      });
    } catch (error) {
      return fail('token_' + error.status);
    }
    await noteGuestyQuota(res);
    if (!res.ok) return fail('token_' + res.status, res);
    let body = null;
    try { body = await res.json(); } catch { /* handled below */ }
    if (!body || typeof body.access_token !== 'string' || !body.access_token || !(Number(body.expires_in) > 0)) {
      return fail('token_malformed');
    }
    const token = {accessToken: body.access_token, expiresAt: now() + Number(body.expires_in) * 1000};
    memo.token = token;
    await stored(() => store.setJSON('token-lease', {until: now() + MIN_TOKEN_GAP_MS, failures: 0}));
    await stored(() => store.setJSON('token', sealToken(token, key)));
    return token;
  }

  async function token() {
    if (fresh(memo.token)) return memo.token;
    const saved = await readToken();
    if (fresh(saved)) return (memo.token = saved);
    // One token request per instance at a time; concurrent callers share it.
    if (!memo.pending) memo.pending = requestToken().finally(() => { memo.pending = null; });
    return memo.pending;
  }

  async function invalidate(rejected) {
    memo.token = null;
    const current = await stored(() => store.getWithMetadata('token', {type: 'json'}));
    const opened = current && openToken(current.data, key);
    if (opened && opened.accessToken === rejected.accessToken) {
      await stored(() => store.setJSON('token', {invalid: true}, {onlyIfMatch: current.etag}));
    }
  }

  // Keep the latest outstanding pause: a shorter Retry-After never replaces a longer one.
  async function pauseApi(until) {
    memo.apiUntil = Math.max(memo.apiUntil || 0, until);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await stored(() => store.getWithMetadata('api-backoff', {type: 'json'}));
      const existing = current && current.data && Number.isFinite(current.data.until) ? current.data.until : 0;
      if (existing >= until) { memo.apiUntil = Math.max(memo.apiUntil, existing); return; }
      const write = await stored(() => store.setJSON('api-backoff', {until}, current ? {onlyIfMatch: current.etag} : {onlyIfNew: true}));
      if (write && write.modified) return;
    }
  }

  async function request(method, path, body) {
    if (memo.apiUntil && now() < memo.apiUntil) throw new GuestyUnavailable('rate_limited');
    const gate = await stored(() => store.get('api-backoff', {type: 'json'}));
    if (gate && now() < gate.until) {
      memo.apiUntil = gate.until;
      throw new GuestyUnavailable('rate_limited');
    }
    const current = await token();
    const headers = {authorization: 'Bearer ' + current.accessToken, accept: 'application/json; charset=utf-8'};
    if (body) headers['content-type'] = 'application/json';
    const res = await send(API_BASE + path, {method, headers, body: body ? JSON.stringify(body) : undefined});
    if (res.status === 401) {
      await invalidate(current);
      throw new GuestyUnavailable('upstream_401');
    }
    if (res.status === 429) {
      // API Intro: queue the next request for the full Retry-After. Without one, wait 30 seconds.
      const wait = retryAfterMs(res, now());
      await pauseApi(now() + Math.max(wait === null ? 30e3 : wait, 1e3));
      throw new GuestyUnavailable('upstream_429');
    }
    if (!res.ok) throw new GuestyUnavailable('upstream_' + res.status);
    try { return await res.json(); } catch { throw new GuestyUnavailable('upstream_malformed'); }
  }

  return {
    token,
    get: path => request('GET', path),
    post: (path, body) => request('POST', path, body)
  };
}
