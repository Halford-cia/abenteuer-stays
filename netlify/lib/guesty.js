// Guesty Booking Engine API client for Netlify Functions. Never import this from browser code.
// Docs of record: booking-api-docs.guesty.com (Authentication, Access token management,
// Handling failed requests). Endpoint paths follow the API reference, server https://booking.guesty.com/.
//
// Token rules from those docs: a token lives 24 hours (expires_in 86400) and an application may
// renew it only a few times a day (the docs say 3 in one place and 5 in another). So the token is
// kept in a site-wide Netlify Blobs store shared by every function instance and every deploy, and
// one lease entry makes sure only one instance at a time ever asks for a new token. After a
// successful request no new token is requested for MIN_TOKEN_GAP_MS, so at most three a day.

export const TOKEN_URL = 'https://booking.guesty.com/oauth2/token';
export const API_BASE = 'https://booking.guesty.com';

const REFRESH_EARLY_MS = 5 * 60e3;       // Guesty's recipe: renew 5 minutes before expiry.
const MIN_TOKEN_GAP_MS = 8 * 3600e3;     // At most three token requests in 24 hours.
const CLAIM_MS = 60e3;                   // How long one instance holds the right to request a token.
const HOUR = 3600e3;

export class GuestyUnavailable extends Error {
  constructor(status) {
    super(status);
    this.status = status;
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function headerSeconds(res, names) {
  for (const name of names) {
    const seconds = Number.parseInt(res.headers.get(name) || '', 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return null;
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

/**
 * store: a Netlify Blobs store (get, getWithMetadata, setJSON with onlyIfNew / onlyIfMatch).
 * memo: an object that outlives one invocation (module scope in the function file).
 */
export function createGuesty({clientId, clientSecret, store, fetch, now = Date.now, memo = {}, timeoutMs = 4000}) {
  if (!clientId || !clientSecret) throw new GuestyUnavailable('not_configured');

  async function stored(op) {
    try { return await op(); } catch { throw new GuestyUnavailable('store_error'); }
  }

  async function send(url, init) {
    try {
      return await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      const name = error && error.name;
      throw new GuestyUnavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
  }

  const fresh = token => Boolean(token && typeof token.accessToken === 'string' && now() < token.expiresAt - REFRESH_EARLY_MS);

  async function requestToken() {
    const lease = await stored(() => store.getWithMetadata('token-lease', {type: 'json'}));
    const state = (lease && lease.data) || {};
    if (state.until && now() < state.until) {
      // Another instance may have just stored a token; use it rather than waiting.
      const latest = await stored(() => store.get('token', {type: 'json'}));
      if (fresh(latest)) return (memo.token = latest);
      throw new GuestyUnavailable('token_backoff');
    }
    const failures = Number.isInteger(state.failures) ? state.failures : 0;
    const claim = await stored(() => store.setJSON('token-lease', {until: now() + CLAIM_MS, failures},
      lease ? {onlyIfMatch: lease.etag} : {onlyIfNew: true}));
    if (!claim || !claim.modified) throw new GuestyUnavailable('token_busy');

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
    if (!res.ok) return fail('token_' + res.status, res);
    let body = null;
    try { body = await res.json(); } catch { /* handled below */ }
    if (!body || typeof body.access_token !== 'string' || !body.access_token || !(Number(body.expires_in) > 0)) {
      return fail('token_malformed');
    }
    const token = {accessToken: body.access_token, expiresAt: now() + Number(body.expires_in) * 1000};
    memo.token = token;
    await stored(() => store.setJSON('token', token));
    await stored(() => store.setJSON('token-lease', {until: now() + MIN_TOKEN_GAP_MS, failures: 0}));
    return token;
  }

  async function token() {
    if (fresh(memo.token)) return memo.token;
    const saved = await stored(() => store.get('token', {type: 'json'}));
    if (fresh(saved)) return (memo.token = saved);
    // One token request per instance at a time; concurrent callers share it.
    if (!memo.pending) memo.pending = requestToken().finally(() => { memo.pending = null; });
    return memo.pending;
  }

  async function invalidate(rejected) {
    memo.token = null;
    const current = await stored(() => store.getWithMetadata('token', {type: 'json'}));
    if (current && current.data && current.data.accessToken === rejected.accessToken) {
      await stored(() => store.setJSON('token', {invalid: true}, {onlyIfMatch: current.etag}));
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
      const seconds = headerSeconds(res, ['retry-after', 'ratelimit-reset']);
      const until = now() + clamp(seconds ? seconds * 1000 : 30e3, 1e3, 10 * 60e3);
      memo.apiUntil = until;
      await stored(() => store.setJSON('api-backoff', {until}));
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
