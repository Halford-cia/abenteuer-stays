import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGuesty, tokenBackoffMs, GuestyUnavailable, TOKEN_ALLOWANCE, sealKey, openToken } from '../netlify/lib/guesty.js';
import { calendarResponse, quoteResponse, mapQuote, mapCalendar, quoteLifetime, resolveStay, today, addDays } from '../netlify/lib/stay-api.js';
import { suggest, listAllListings, requestOwnerToken, run, MAX_PAGES } from '../scripts/guesty-listings.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const LISTING = '5bf544a600a9b000389f81d8';
const CLIENT = 'client-id';
const SECRET = 'client-secret-value';
const TOKEN = 'issued-token-value';
const NOW = Date.parse('2026-12-01T18:00:00Z');
// The documented addresses, written out here rather than imported, so a wrong address in the code
// fails these tests (Authentication page; API reference, server https://booking.guesty.com).
const TOKEN_URL = 'https://booking.guesty.com/oauth2/token';
const QUOTE_URL = 'https://booking.guesty.com/api/reservations/quotes';
const CALENDAR_URL = `https://booking.guesty.com/api/listings/${LISTING}/calendar?from=2026-12-01&to=2027-11-30`;

// In-memory stand-in for a Netlify Blobs store, with ETags and conditional writes.
// failWrites: keys whose writes throw, as a failing Blobs write would.
// faults: {key: n => 'throw' | 'reject' | undefined} decides the n-th write (from 1) of a key:
// throw as a failing Blobs write does, or come back {modified: false} as a lost conditional write does.
function memoryStore({failWrites = [], faults = {}} = {}) {
  const data = new Map();
  const writes = {};
  let version = 0;
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key).value) : null; },
    async getWithMetadata(key) {
      return data.has(key) ? {data: structuredClone(data.get(key).value), etag: data.get(key).etag, metadata: {}} : null;
    },
    async setJSON(key, value, options = {}) {
      if (failWrites.includes(key)) throw new Error('blobs write failed');
      writes[key] = (writes[key] || 0) + 1;
      const fault = faults[key] && faults[key](writes[key]);
      if (fault === 'throw') throw new Error('blobs write failed');
      if (fault === 'reject') return {modified: false};
      const current = data.get(key);
      if (options.onlyIfNew && current) return {modified: false};
      if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return {modified: false};
      const etag = 'e' + ++version;
      data.set(key, {value: structuredClone(value), etag});
      return {modified: true, etag};
    }
  };
}

const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), {status, headers});

// A plan in the OpenAPI schema's layout: name and money inside ratePlans[].ratePlan.
const schemaPlan = (name, items, extra = {}) => ({ratePlan: {_id: 'rp-' + name, name, money: {currency: 'USD', invoiceItems: items, ...extra}}});
// A plan in the Reservation Quote Flow example's layout: name and money on ratePlans[] itself.
const flowPlan = (name, items, extra = {}) => ({name, days: [], money: {currency: 'USD', invoiceItems: items, ...extra}});
// Guesty holds a quote's prices for 24 hours (Reservation Quote Flow); expiresAt is required.
const EXPIRES = new Date(NOW + 86400e3).toISOString();
const quoteWith = (...ratePlans) => ({_id: 'q1', createdAt: new Date(NOW).toISOString(), expiresAt: EXPIRES, promotions: {}, coupons: [], rates: {ratePlans}});
const quoteBody = (items, extra = {}) => quoteWith(schemaPlan('Standard', items, extra));
const standardItems = [
  {title: 'Accommodation fare', amount: 600, currency: 'USD', type: 'ACCOMMODATION_FARE'},
  {title: 'Cleaning fee', amount: 95, currency: 'USD'},
  {title: 'Hotel occupancy tax', amount: 69.5, currency: 'USD'}
];
const standardMoney = {hostPayout: 764.5, subTotalPrice: 695, totalTaxes: 69.5, totalFees: 95};

// A fake Guesty: routes by URL, counts calls, and records what was sent.
function fakeGuesty(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({href, init});
    for (const [match, handler] of routes) if (href.includes(match)) return handler(init, calls);
    throw new Error('unexpected ' + href);
  };
  return {fetch, calls, tokenCalls: () => calls.filter(c => c.href === TOKEN_URL).length};
}
const tokenOk = () => json(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN, scope: 'booking_engine:api'});
// Guesty never answers before the client's deadline: the request is aborted.
const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

function deps(guesty, overrides = {}) {
  const lines = [];
  let clock = NOW;
  return {
    lines,
    tick: ms => { clock += ms; },
    env: {GUESTY_BE_CLIENT_ID: CLIENT, GUESTY_BE_CLIENT_SECRET: SECRET},
    store: memoryStore(), fetch: guesty.fetch, now: () => clock, log: line => lines.push(line),
    memo: {}, stays, listings: {'lunar-dome': LISTING}, timeoutMs: 50,
    ...overrides
  };
}
// The documented token request (Authentication page): POST to the token URL, form-encoded, with
// exactly grant_type, scope, client_id and client_secret.
function assertTokenRequest(call, clientId = CLIENT, clientSecret = SECRET) {
  assert.equal(call.href, 'https://booking.guesty.com/oauth2/token');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(call.init.headers.accept, 'application/json');
  assert.ok(call.init.body instanceof URLSearchParams, 'the body is form-encoded');
  assert.deepEqual([...call.init.body].sort(), [
    ['client_id', clientId], ['client_secret', clientSecret], ['grant_type', 'client_credentials'], ['scope', 'booking_engine:api']]);
  assert.equal(String(call.init.body), new URLSearchParams([['grant_type', 'client_credentials'], ['scope', 'booking_engine:api'],
    ['client_id', clientId], ['client_secret', clientSecret]]).toString());
}
const params = query => new URLSearchParams(query);
const goodQuery = {checkIn: '2026-12-10', checkOut: '2026-12-13', guests: '2'};
const statuses = d => d.lines.map(line => JSON.parse(line).status);

test('the token is requested once and reused across calls, instances and until it is near expiry', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [{date: '2026-12-02', status: 'available'}])]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  await calendarResponse('lunar-dome', d);
  assert.equal(guesty.tokenCalls(), 1);
  // A cold instance (empty memo) reads the shared store instead of asking Guesty.
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 1);
  assertTokenRequest(guesty.calls[0]);
  const api = guesty.calls.find(c => c.href.includes('/calendar'));
  assert.equal(api.init.headers.authorization, 'Bearer ' + TOKEN);
  // 23 h 56 min later the token is within five minutes of expiry, the gap has passed: renew once.
  d.tick(86400e3 - 4 * 60e3);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 2);
});

test('the shared store never holds a usable token: it is sealed under a key only the client secret gives', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [{date: '2026-12-02', status: 'available'}])]]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('lunar-dome', d)).status, 200);
  // What a build plugin (site-wide read access, no Functions-only secret) can read:
  const everything = JSON.stringify([...d.store.data.entries()]);
  assert.ok(!everything.includes(TOKEN), 'the bearer token is readable in the store');
  assert.ok(!everything.includes(Buffer.from(TOKEN).toString('base64')));
  const record = d.store.data.get('token').value;
  assert.equal(openToken(record, sealKey(CLIENT, 'some-other-secret')), null);
  assert.equal(openToken({...record, expiresAt: record.expiresAt + 1}, sealKey(CLIENT, SECRET)), null);   // tampered: refused
  assert.equal(openToken(record, sealKey(CLIENT, SECRET)).accessToken, TOKEN);
  // A plaintext record (the old format, or one written by anyone else) is never sent as a bearer.
  const plantedGuesty = fakeGuesty([[TOKEN_URL, () => json(500, {})]]);
  const planted = deps(plantedGuesty);
  await planted.store.setJSON('token', {accessToken: 'planted-token', expiresAt: NOW + 86400e3});
  assert.equal((await calendarResponse('lunar-dome', planted)).status, 502);
  assert.deepEqual(plantedGuesty.calls.map(c => c.href), [TOKEN_URL]);
  assert.ok(!JSON.stringify(plantedGuesty.calls).includes('planted-token'));
});

test('concurrent requests in one instance share a single token request', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [{date: '2026-12-02', status: 'available'}])]]);
  const d = deps(guesty);
  await Promise.all([1, 2, 3, 4, 5].map(() => calendarResponse('lunar-dome', d)));
  assert.equal(guesty.tokenCalls(), 1);
});

test('a second instance never requests a token while another holds the lease', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [])]]);
  const d = deps(guesty);
  await d.store.setJSON('token-lease', {until: NOW + 30e3, failures: 0});
  const res = await calendarResponse('lunar-dome', d);
  assert.equal(res.status, 503);
  assert.equal(guesty.tokenCalls(), 0);
  assert.deepEqual(statuses(d), ['token_backoff']);
});

test('a token issued but not saved cannot be followed by more: six cold invocations in five minutes get one token', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [{date: '2026-12-02', status: 'available'}])]]);
  const d = deps(guesty, {store: memoryStore({failWrites: ['token']})});
  for (let i = 0; i < 6; i++) {
    await calendarResponse('lunar-dome', {...d, memo: {}});
    d.tick(60e3);
  }
  assert.equal(guesty.tokenCalls(), 1);
  assert.deepEqual(statuses(d), ['store_error', 'token_backoff', 'token_backoff', 'token_backoff', 'token_backoff', 'token_backoff']);
});

test('every token request is counted before it is sent: lost replies spend at most the 3-a-day allowance', async () => {
  // Guesty may have issued each of these tokens; the reply never arrives.
  const guesty = fakeGuesty([[TOKEN_URL, hang]]);
  const d = deps(guesty);
  for (let i = 0; i < 12; i++) {
    await calendarResponse('lunar-dome', {...d, memo: {}});
    d.tick(62 * 60e3 / 6);
  }
  assert.equal(TOKEN_ALLOWANCE, 3);
  assert.equal(guesty.tokenCalls(), 3);
  assert.equal(statuses(d).filter(s => s === 'token_timeout').length, 3);
  assert.ok(statuses(d).includes('token_allowance'));
  // 24 hours after the first attempt one slot frees up.
  d.tick(24 * 3600e3 - 12 * 62 * 60e3 / 6 + 1);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 4);
});

test('when the attempt cannot be recorded, no token is requested', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk]]);
  const d = deps(guesty, {store: memoryStore({failWrites: ['token-issuance']})});
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  assert.equal(guesty.tokenCalls(), 0);
  assert.deepEqual(statuses(d), ['store_error']);
});

test('Guesty\'s own ratelimit-remaining lowers the allowance until its reset', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, () => json(500, {}, {'ratelimit-limit': '5', 'ratelimit-remaining': '0', 'ratelimit-reset': '7200'})]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  d.tick(30 * 60e3);                                           // past the 2-minute 5xx backoff
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 1);
  assert.equal(statuses(d).at(-1), 'token_allowance');
  d.tick(7200e3);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 2);
});

test('a refused token request backs off instead of retrying on every page view', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, () => json(401, {error: 'invalid_client'})]]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  for (let i = 0; i < 5; i++) await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 1);
  assert.equal(statuses(d)[0], 'token_401');
  d.tick(61 * 60e3);
  await calendarResponse('lunar-dome', d);
  assert.equal(guesty.tokenCalls(), 2);
  // The second failure waits twice as long.
  d.tick(61 * 60e3);
  await calendarResponse('lunar-dome', d);
  assert.equal(guesty.tokenCalls(), 2);
});

test('a rate-limited token request honours Guesty\'s reset header', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, () => json(429, {}, {'ratelimit-reset': '7200'})]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  d.tick(7100e3);
  await calendarResponse('lunar-dome', d);
  assert.equal(guesty.tokenCalls(), 1);
  d.tick(200e3);
  await calendarResponse('lunar-dome', d);
  assert.equal(guesty.tokenCalls(), 2);
  assert.equal(tokenBackoffMs(429, 0, null), 3600e3);
  assert.equal(tokenBackoffMs(500, 0, null), 120e3);
  assert.equal(tokenBackoffMs(401, 10, null), 24 * 3600e3);
});

test('a 401 from the API drops the stored token, and the next token waits for the minimum gap', async () => {
  let rejected = true;
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => (rejected ? json(401, {}) : json(200, [{date: '2026-12-02', status: 'available'}]))]]);
  const d = deps(guesty);
  const res = await calendarResponse('lunar-dome', d);
  assert.equal(res.status, 502);
  assert.deepEqual(d.store.data.get('token').value, {invalid: true});
  rejected = false;
  assert.equal((await calendarResponse('lunar-dome', {...d, memo: {}})).status, 503);
  assert.equal(guesty.tokenCalls(), 1);
  d.tick(8 * 3600e3 + 1);
  assert.equal((await calendarResponse('lunar-dome', {...d, memo: {}})).status, 200);
  assert.equal(guesty.tokenCalls(), 2);
});

test('a 429 from the API pauses every instance for the Retry-After period', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(429, {}, {'retry-after': '20'})]]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  const before = guesty.calls.length;
  assert.equal((await calendarResponse('lunar-dome', {...d, memo: {}})).status, 503);
  assert.equal(guesty.calls.length, before);
  d.tick(21e3);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.calls.length, before + 1);
});

test('the API pause honours the whole Retry-After, and a shorter one never replaces a longer one', async () => {
  let wait = '1800';
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(429, {}, {'retry-after': wait})]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  const calendarCalls = () => guesty.calls.filter(c => c.href.includes('/calendar')).length;
  assert.equal(d.store.data.get('api-backoff').value.until, NOW + 1800e3);
  d.tick(11 * 60e3);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(calendarCalls(), 1, 'a second upstream call at minute 11');
  d.tick(19 * 60e3 - 1e3);
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(calendarCalls(), 1, 'a second upstream call before minute 30');
  d.tick(2e3);
  wait = '20';
  await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(calendarCalls(), 2);
});

test('two workers that both hit a 429 keep the later deadline', async () => {
  const store = memoryStore();
  const waits = ['1800', '20'];
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(429, {}, {'retry-after': waits.shift()})]]);
  const make = () => createGuesty({clientId: CLIENT, clientSecret: SECRET, store, fetch: guesty.fetch, now: () => NOW,
    memo: {token: {accessToken: TOKEN, expiresAt: NOW + 86400e3}}, timeoutMs: 50});
  const [a, b] = [make(), make()];
  // Both pass the gate before either stores its pause.
  const pending = [a.get('/api/listings/x/calendar'), b.get('/api/listings/x/calendar')];
  await Promise.allSettled(pending);
  assert.equal((await store.getWithMetadata('api-backoff')).data.until, NOW + 1800e3);
});

test('an HTTP-date Retry-After is honoured', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(429, {}, {'retry-after': new Date(NOW + 3600e3).toUTCString()})]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  assert.equal(d.store.data.get('api-backoff').value.until, NOW + 3600e3);
});

for (const [name, handler, reason] of [
  ['500', () => json(500, {}), 'upstream_500'], ['503', () => json(503, {}), 'upstream_503'],
  ['malformed body', () => new Response('<html>', {status: 200}), 'upstream_malformed'],
  ['timeout', hang, 'timeout'],
  ['network error', () => Promise.reject(new TypeError('fetch failed')), 'network']
]) {
  test(`a quote falls back without a price on ${name}`, async () => {
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, handler]]);
    const d = deps(guesty);
    const res = await quoteResponse('lunar-dome', params(goodQuery), d);
    assert.deepEqual(guesty.calls.map(c => [c.init.method, c.href]), [['POST', TOKEN_URL], ['POST', QUOTE_URL]]);
    assert.deepEqual(statuses(d), [reason]);
    assert.ok(res.status >= 500);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {ok: false});
  });
}

test('a timeout is logged as a timeout', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [CALENDAR_URL, hang]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  assert.deepEqual(guesty.calls.map(c => c.href), [TOKEN_URL, CALENDAR_URL]);
  assert.deepEqual(statuses(d), ['timeout']);
});

test('the quote shows Guesty\'s guest charge (hostPayout) and lines, and sends no guest details', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, quoteBody(standardItems, standardMoney))]]);
  const d = deps(guesty);
  const res = await quoteResponse('lunar-dome', params(goodQuery), d);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {ok: true, checkIn: '2026-12-10', checkOut: '2026-12-13', nights: 3, guests: 2, currency: 'USD',
    lines: [{title: 'Accommodation fare', amount: 600}, {title: 'Cleaning fee', amount: 95}, {title: 'Hotel occupancy tax', amount: 69.5}],
    nightly: [], total: 764.5, ratePlan: '', validFor: 86400 - 60 - 600});
  const sent = JSON.parse(guesty.calls.find(c => c.href === QUOTE_URL).init.body);
  assert.deepEqual(sent, {listingId: LISTING, checkInDateLocalized: '2026-12-10', checkOutDateLocalized: '2026-12-13', guestsCount: 2});
  assert.equal(guesty.calls.find(c => c.href === QUOTE_URL).init.method, 'POST');
  assert.equal(res.headers.get('netlify-cdn-cache-control'), 'public, durable, s-maxage=300, stale-while-revalidate=300');
  assert.equal(res.headers.get('netlify-vary'), 'query=checkIn|checkOut|guests');
});

test('quote mapping refuses rather than showing a total that differs from the guest charge', () => {
  const line = amount => [{title: 'Accommodation fare', amount, currency: 'USD'}];
  // The review's two cases: lines that do not add up to hostPayout are never shown.
  assert.throws(() => mapQuote(quoteBody(line(100), {hostPayout: 100.01, subTotalPrice: 100.01, totalTaxes: 0})), /quote_total_mismatch/);
  assert.throws(() => mapQuote(quoteBody(line(100), {hostPayout: 120})), /quote_total_mismatch/);
  // No guest charge: no quote, whatever the lines say.
  assert.throws(() => mapQuote(quoteBody(standardItems, {subTotalPrice: 695, totalTaxes: 69.5})), /quote_malformed/);
  assert.throws(() => mapQuote(quoteBody(line(100), {hostPayout: 0})), /quote_malformed/);
  // More precision than the currency has is ambiguous.
  assert.throws(() => mapQuote(quoteBody([{title: 'Fare', amount: 33.333, currency: 'USD'}, {title: 'Fee', amount: 66.667, currency: 'USD'}], {hostPayout: 100})), /quote_total_mismatch/);
  // A line in another currency than the plan's.
  assert.throws(() => mapQuote(quoteBody([{title: 'Fare', amount: 100, currency: 'EUR'}], {hostPayout: 100})), /quote_malformed/);
  assert.throws(() => mapQuote({rates: {ratePlans: [{ratePlan: {name: 'x', money: {invoiceItems: line(100), hostPayout: 100}}}]}}), /quote_malformed/);   // no plan currency
  // Plans in different currencies are never compared.
  assert.throws(() => mapQuote(quoteWith(schemaPlan('A', line(100), {hostPayout: 100}),
    {ratePlan: {name: 'B', money: {currency: 'EUR', hostPayout: 90, invoiceItems: [{title: 'Fare', amount: 90, currency: 'EUR'}]}}})), /quote_currency_mismatch/);
  // One unreadable plan makes the whole quote ambiguous.
  assert.throws(() => mapQuote(quoteWith(schemaPlan('A', line(100), {hostPayout: 100}), schemaPlan('B', line(90), {hostPayout: 95}))), /quote_total_mismatch/);
  assert.throws(() => mapQuote({rates: {ratePlans: []}}), GuestyUnavailable);
  assert.throws(() => mapQuote(quoteBody([], {hostPayout: 100})), /quote_malformed/);
  assert.throws(() => mapQuote(quoteBody([{title: 'Fare', amount: 'six hundred', currency: 'USD'}], {hostPayout: 600})), /quote_malformed/);
  // Float noise in Guesty's numbers is not a mismatch.
  assert.equal(mapQuote(quoteBody([{title: 'Fare', amount: 0.1, currency: 'USD'}, {title: 'Fee', amount: 0.2, currency: 'USD'}], {hostPayout: 0.30000000000000004})).total, 0.3);
  // A line with included taxes counts once, at its own amount.
  assert.equal(mapQuote(quoteBody([{title: 'Fare', amount: 110, currency: 'USD', includedTaxesList: [{type: 'TAX', title: 'Hotel tax'}]}], {hostPayout: 110})).total, 110);
});

test('both documented plan layouts keep each plan\'s own name, currency and invoice', () => {
  const flexible = [{title: 'Fare', amount: 500, currency: 'USD'}];
  const nonRefundable = [{title: 'Fare', amount: 450, currency: 'USD'}];
  const expected = {currency: 'USD', lines: [{title: 'Fare', amount: 450}], nightly: [], total: 450, ratePlan: 'Non-refundable', expiresAt: Date.parse(EXPIRES)};
  // Reservation Quote Flow example: name and money directly on each ratePlans[] entry.
  assert.deepEqual(mapQuote(quoteWith(flowPlan('Flexible', flexible, {hostPayout: 500}), flowPlan('Non-refundable', nonRefundable, {hostPayout: 450}))), expected);
  // OpenAPI schema: both inside ratePlans[].ratePlan.
  assert.deepEqual(mapQuote(quoteWith(schemaPlan('Flexible', flexible, {hostPayout: 500}), schemaPlan('Non-refundable', nonRefundable, {hostPayout: 450}))), expected);
  // Mixed within one response, and money beside a named ratePlan.
  assert.deepEqual(mapQuote(quoteWith(schemaPlan('Flexible', flexible, {hostPayout: 500}),
    {ratePlan: {_id: 'b', name: 'Non-refundable'}, money: {currency: 'USD', hostPayout: 450, invoiceItems: nonRefundable}})), expected);
  // One plan: no plan name is shown.
  assert.equal(mapQuote(quoteWith(flowPlan('Flexible', flexible, {hostPayout: 500}))).ratePlan, '');
});

test('the calendar maps Guesty statuses, minimum nights and closed arrival or departure days', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [CALENDAR_URL, () => json(200, [
    {date: '2026-12-02', status: 'available', minNights: 2, isBaseMinNights: true, cta: false, ctd: true, allotment: 1},
    {date: '2026-12-03', status: 'booked', minNights: 2},
    {date: '2026-12-04', status: 'reserved'},
    {date: '2026-12-05', status: 'available', cta: true, minNights: 1},
    {date: '2026-12-06', status: 'unavailable', minNights: 3}
  ])]]);
  const d = deps(guesty);
  const res = await calendarResponse('lunar-dome', d);
  const body = await res.json();
  assert.equal(body.from, '2026-12-01');
  assert.equal(body.to, '2027-11-30');
  assert.deepEqual(guesty.calls.map(c => c.href), [TOKEN_URL, CALENDAR_URL]);
  assert.deepEqual(body.days, [
    {date: '2026-12-02', available: true, minNights: 2, noArrival: false, noDeparture: true},
    {date: '2026-12-03', available: false, minNights: 2, noArrival: false, noDeparture: false},
    {date: '2026-12-04', available: false, minNights: null, noArrival: false, noDeparture: false},
    {date: '2026-12-05', available: true, minNights: 1, noArrival: true, noDeparture: false},
    {date: '2026-12-06', available: false, minNights: 3, noArrival: false, noDeparture: false}
  ]);
  assert.match(res.headers.get('netlify-cdn-cache-control'), /s-maxage=300/);
  assert.throws(() => mapCalendar({}, '2026-12-01', '2026-12-31'), /calendar_malformed/);
});

test('an unusable calendar is the silent, uncached fallback, never dates shown as taken', async () => {
  for (const [name, days] of [
    ['missing status', [{date: '2026-12-02', minNights: 1}, {date: '2026-12-03', status: 'available'}]],
    ['unknown status', [{date: '2026-12-02', status: 'blocked'}]],
    ['empty array', []],
    ['wholly invalid rows', [{date: 'not-a-date', status: 'available'}, null]],
    ['minNights not a positive integer', [{date: '2026-12-02', status: 'available', minNights: 0}]],
    ['cta not a boolean', [{date: '2026-12-02', status: 'available', cta: 'true'}]],
    ['nothing inside the requested range', [{date: '2030-01-01', status: 'available'}]]
  ]) {
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [CALENDAR_URL, () => json(200, days)]]);
    const d = deps(guesty);
    const res = await calendarResponse('lunar-dome', d);
    assert.equal(res.status, 502, name);
    assert.equal(res.headers.get('cache-control'), 'no-store', name);
    assert.equal(res.headers.get('netlify-cdn-cache-control'), null, name);
    assert.deepEqual(await res.json(), {ok: false}, name);
    assert.deepEqual(statuses(d), ['calendar_malformed'], name);
  }
});

test('an unmapped or unknown stay, or missing credentials, never reaches Guesty', async () => {
  const guesty = fakeGuesty([]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('cloud-dome', d)).status, 404);
  assert.equal((await quoteResponse('cloud-dome', params(goodQuery), d)).status, 404);
  assert.equal((await calendarResponse('../etc', d)).status, 404);
  assert.equal((await calendarResponse('lunar-dome', {...d, env: {}})).status, 503);
  assert.equal(guesty.calls.length, 0);
  assert.deepEqual(statuses(d), ['unmapped', 'unmapped', 'unknown_stay', 'not_configured']);
  assert.equal(resolveStay('lunar-dome', stays, {'lunar-dome': 'not valid!'}).listingId, null);
  assert.equal(resolveStay('lunar-dome', stays, {}).listingId, null);
});

test('quote input is checked before any call to Guesty, and the whole stay stays within two years', async () => {
  const guesty = fakeGuesty([]);
  const d = deps(guesty);
  const day = n => addDays('2026-12-01', n);
  for (const query of [
    {...goodQuery, checkIn: '2026-11-30'},                              // before today in Texas
    {...goodQuery, checkOut: '2026-12-10'},                             // zero nights
    {...goodQuery, checkIn: '2026-02-30'},                              // not a date
    {...goodQuery, checkOut: '2027-03-01'},                             // longer than 60 nights
    {...goodQuery, guests: '3'},                                        // Lunar Dome sleeps 2
    {...goodQuery, guests: '0'}, {...goodQuery, guests: '1.5'},
    {checkIn: day(730), checkOut: day(731), guests: '2'},               // check-in on day 730
    {checkIn: day(700), checkOut: day(731), guests: '2'},               // check-out past day 730
    {checkIn: '2029-01-01', checkOut: '2029-01-03', guests: '2'}        // beyond two years
  ]) assert.equal((await quoteResponse('lunar-dome', params(query), d)).status, 400, JSON.stringify(query));
  assert.equal(guesty.calls.length, 0);
  // The last stay inside the horizon still reaches Guesty.
  const ok = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, quoteBody(standardItems, standardMoney))]]);
  assert.equal((await quoteResponse('lunar-dome', params({checkIn: day(729), checkOut: day(730), guests: '2'}), deps(ok))).status, 200);
});

test('logs carry only the listing id, the dates and a status, never a credential or token', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk],
    [QUOTE_URL, () => json(200, quoteBody(standardItems, standardMoney))], [CALENDAR_URL, () => json(500, {})]]);
  const d = deps(guesty);
  await quoteResponse('lunar-dome', params(goodQuery), d);
  await calendarResponse('lunar-dome', d);
  await quoteResponse('lunar-dome', params({checkIn: 'Jane Doe <jane@example.com>', checkOut: 'x', guests: '2'}), d);
  const entries = d.lines.map(line => JSON.parse(line));
  assert.deepEqual(entries.map(e => [e.fn, e.status]), [['quote', 'ok'], ['calendar', 'upstream_500'], ['quote', 'bad_request']]);
  assert.deepEqual(entries[0], {fn: 'quote', listing: LISTING, checkIn: '2026-12-10', checkOut: '2026-12-13', status: 'ok'});
  assert.deepEqual(entries[2], {fn: 'quote', listing: LISTING, checkIn: null, checkOut: null, status: 'bad_request'});
  for (const [i, raw] of d.lines.entries()) {
    assert.deepEqual(Object.keys(entries[i]).sort(), entries[i].fn === 'quote' ? ['checkIn', 'checkOut', 'fn', 'listing', 'status'] : ['fn', 'from', 'listing', 'status', 'to']);
    assert.ok(!raw.includes(SECRET) && !raw.includes(TOKEN) && !raw.includes('jane'));
  }
});

test('without a working token store Guesty is never called (no token without the shared lease)', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [])]]);
  const d = deps(guesty, {store: null});
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  assert.equal(guesty.calls.length, 0);
  assert.deepEqual(statuses(d), ['store_error']);
});

test('the Guesty client refuses to start without both credentials', () => {
  assert.throws(() => createGuesty({clientId: 'x', clientSecret: '', store: memoryStore(), fetch}), /not_configured/);
});

test('today is the Texas date', () => {
  assert.equal(today(Date.parse('2026-12-02T03:00:00Z')), '2026-12-01');
});

test('the listing map names every stay, and only Guesty-style ids', () => {
  const map = JSON.parse(read('data/guesty-listings.json'));
  assert.deepEqual(Object.keys(map).sort(), stays.map(s => s.slug).sort());
  for (const value of Object.values(map)) assert.match(value, /^(|[A-Za-z0-9]{6,64})$/);
});

test('the owner script suggests a listing only for a single title match', () => {
  const map = suggest(stays, [
    {id: 'aaaaaa1', title: 'Lunar Dome W/ Private Hot tub and Outdoor Shower'},
    {id: 'bbbbbb2', title: 'Cloud Dome - Hot Tub'}, {id: 'cccccc3', title: 'Cloud Dome (copy)'},
    {id: 'dddddd4', title: 'Das Grün Haus With Private Hot Tub'}
  ]);
  assert.equal(map['lunar-dome'], 'aaaaaa1');
  assert.equal(map['cloud-dome'], '');
  assert.equal(map['treehouse-serenity-dome'], '');
  assert.equal(Object.keys(map).length, stays.length);
});

test('the owner script reads every listing page, and refuses a reply that would look like an empty or partial inventory', async () => {
  const pages = {'': {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 2, cursor: {next: 'c2'}}},
    c2: {results: [{_id: 'bbbbbb2', title: 'Cloud Dome'}], pagination: {total: 2, cursor: {next: null}}}};
  const seen = [];
  const listingsFetch = body => async url => { seen.push(String(url)); return json(200, typeof body === 'function' ? body(new URL(url)) : body); };
  assert.deepEqual(await listAllListings(listingsFetch(url => pages[url.searchParams.get('cursor') || '']), 't'),
    [{id: 'aaaaaa1', title: 'Lunar Dome'}, {id: 'bbbbbb2', title: 'Cloud Dome'}]);
  assert.deepEqual(seen, ['https://booking.guesty.com/api/listings?fields=_id+title&limit=100',
    'https://booking.guesty.com/api/listings?fields=_id+title&limit=100&cursor=c2']);
  await assert.rejects(listAllListings(listingsFetch({pagination: {cursor: {next: null}}}), 't'), /without its results list/);
  await assert.rejects(listAllListings(listingsFetch({results: [{title: 'no id'}]}), 't'), /without an id/);
  seen.length = 0;
  await assert.rejects(listAllListings(listingsFetch({results: [], pagination: {cursor: {next: 'more'}}}), 't'), /incomplete/);
  assert.equal(seen.length, MAX_PAGES);
});

// ---- Round 2 (review 441r2b) ----

// Blocker 1: a quote's price lives only as long as Guesty holds it.
test('the quote carries its expiry: the CDN never keeps it past expiresAt, and the browser is told how long to show it', async () => {
  const at = expiresIn => ({...quoteBody(standardItems, standardMoney), expiresAt: new Date(NOW + expiresIn * 1000).toISOString()});
  const run = async body => {
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, body)]]);
    const d = deps(guesty);
    const res = await quoteResponse('lunar-dome', params(goodQuery), d);
    return {res, body: await res.json(), d};
  };
  // 24 hours: five minutes fresh and five stale in the CDN; the browser may show it for the rest,
  // less a minute's margin and the longest time the reply may have sat in the CDN.
  let r = await run(at(86400));
  assert.equal(r.res.headers.get('netlify-cdn-cache-control'), 'public, durable, s-maxage=300, stale-while-revalidate=300');
  assert.equal(r.body.validFor, 86400 - 60 - 600);
  assert.ok(!('expiresAt' in r.body));
  // Ten minutes left: cached for less, and CDN age plus display time never pass the expiry.
  r = await run(at(600));
  assert.equal(r.res.headers.get('netlify-cdn-cache-control'), 'public, durable, s-maxage=300, stale-while-revalidate=180');
  assert.equal(r.body.validFor, 60);
  assert.ok(300 + 180 + r.body.validFor <= 600 - 60);
  // Three minutes left: a minute in the CDN, a minute on screen.
  r = await run(at(180));
  assert.equal(r.res.headers.get('netlify-cdn-cache-control'), 'public, durable, s-maxage=60');
  assert.equal(r.body.validFor, 60);
  // Two minutes left: shown for a minute, not cached at all.
  r = await run(at(120));
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.equal(r.res.headers.get('netlify-cdn-cache-control'), null);
  assert.equal(r.body.validFor, 60);
  // Too close to expiry, already expired, or no expiry: no price, the uncached fallback.
  for (const [body, status] of [[at(90), 'quote_expired'], [at(-60), 'quote_expired'],
    [{...quoteBody(standardItems, standardMoney), expiresAt: undefined}, 'quote_malformed'],
    [{...quoteBody(standardItems, standardMoney), expiresAt: 'tomorrow'}, 'quote_malformed']]) {
    r = await run(body);
    assert.equal(r.res.status, 502, status);
    assert.equal(r.res.headers.get('cache-control'), 'no-store', status);
    assert.deepEqual(r.body, {ok: false});
    assert.deepEqual(statuses(r.d), [status]);
  }
  // Every lifetime keeps CDN time plus display time inside the hold, less the margin.
  for (const seconds of [121, 300, 659, 660, 661, 3600, 86400]) {
    const life = quoteLifetime(NOW + seconds * 1000, NOW);
    assert.ok(life.sMaxAge + life.staleWhileRevalidate + life.validFor <= seconds - 60, String(seconds));
    assert.ok(life.validFor >= 60, String(seconds));
  }
  assert.equal(quoteLifetime(NOW + 119e3, NOW), null);
});

// Blocker 3: Guesty's own count survives a failed or lost write.
for (const [name, fault] of [['throws', 'throw'], ['is a rejected conditional write', 'reject']]) {
  test(`when the write recording Guesty's zero balance ${name}, no token is requested until the hold ends`, async () => {
    const guesty = fakeGuesty([[TOKEN_URL, () => json(500, {}, {'ratelimit-limit': '5', 'ratelimit-remaining': '0', 'ratelimit-reset': '7200'})]]);
    // Write 1 counts the attempt (and sets the hold); every later write of the record fails until
    // the store recovers.
    let broken = true;
    const d = deps(guesty, {store: memoryStore({faults: {'token-issuance': n => (n > 1 && broken ? fault : undefined)}})});
    assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
    assert.equal(guesty.tokenCalls(), 1);
    d.tick(3 * 60e3);                                          // past the 2-minute 5xx backoff
    assert.equal((await calendarResponse('lunar-dome', {...d, memo: {}})).status, 503);
    d.tick(2 * 3600e3);                                        // past Guesty's reset too: the hold still stands
    await calendarResponse('lunar-dome', {...d, memo: {}});
    assert.equal(guesty.tokenCalls(), 1, 'a token request while Guesty\'s count was unrecorded');
    assert.deepEqual(statuses(d), ['token_500', 'token_hold', 'token_hold']);
    // The hold lasts 24 hours from the attempt, the longest a used slot takes to regenerate.
    broken = false;
    d.tick(22 * 3600e3 - 3 * 60e3 - 1);
    await calendarResponse('lunar-dome', {...d, memo: {}});
    assert.equal(guesty.tokenCalls(), 1);
    d.tick(2);
    await calendarResponse('lunar-dome', {...d, memo: {}});
    assert.equal(guesty.tokenCalls(), 2);
  });
}

test('the hold is written with the attempt, before the request, and lifted by the write that records the answer', async () => {
  let seenAtSend = null;
  const store = memoryStore();
  const guesty = fakeGuesty([[TOKEN_URL, async () => {
    seenAtSend = structuredClone((await store.getWithMetadata('token-issuance')).data);
    return json(500, {}, {'ratelimit-remaining': '2', 'ratelimit-reset': '600'});
  }]]);
  const d = deps(guesty, {store});
  await calendarResponse('lunar-dome', d);
  assert.deepEqual(seenAtSend.attempts, [NOW]);
  assert.deepEqual(seenAtSend.hold, {at: NOW, until: NOW + 86400e3});
  const after = store.data.get('token-issuance').value;
  assert.equal(after.hold, undefined);
  assert.deepEqual(after.guesty, {remaining: 2, at: NOW, resetAt: NOW + 600e3});
  // A lost reply has no count to keep: the attempt stays counted and the hold is lifted.
  const lost = fakeGuesty([[TOKEN_URL, hang]]);
  const l = deps(lost);
  await calendarResponse('lunar-dome', l);
  assert.equal(l.store.data.get('token-issuance').value.hold, undefined);
  assert.equal(l.store.data.get('token-issuance').value.attempts.length, 1);
  // A conditional write that loses once is retried against the new record, and still lifts the hold.
  const retried = deps(fakeGuesty([[TOKEN_URL, () => json(500, {}, {'ratelimit-remaining': '1', 'ratelimit-reset': '60'})]]),
    {store: memoryStore({faults: {'token-issuance': n => (n === 2 ? 'reject' : undefined)}})});
  await calendarResponse('lunar-dome', retried);
  assert.equal(retried.store.data.get('token-issuance').value.hold, undefined);
  assert.equal(retried.store.data.get('token-issuance').value.guesty.remaining, 1);
});

// Fix 1: the deadline covers the body, not only the headers.
const slowBody = (status, body, ms, headers = {}) => init => new Response(new ReadableStream({
  start(controller) {
    const timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); }, ms);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(init.signal.reason); });
  }
}), {status, headers});
const deafBody = (status, body, ms) => () => ({ok: status < 300, status, headers: new Headers(),
  json: () => new Promise(resolve => setTimeout(() => resolve(body), ms))});

for (const [name, makeBody] of [['a signal-aware body', slowBody], ['a body that ignores the signal', deafBody]]) {
  test(`a stall after good headers is a timeout, for the token and for the data (${name})`, async () => {
    // Token body stalls.
    // The body would arrive at 400 ms; the 10 ms deadline must end the call long before that.
    const tokenStall = fakeGuesty([[TOKEN_URL, makeBody(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN}, 400)]]);
    const t = deps(tokenStall, {timeoutMs: 10});
    const started = Date.now();
    assert.equal((await calendarResponse('lunar-dome', t)).status, 502);
    assert.ok(Date.now() - started < 300, `took ${Date.now() - started} ms`);
    assert.deepEqual(statuses(t), ['token_timeout']);
    assert.equal(t.memo.pending, null);                         // the shared renewal is released
    // Data body stalls.
    const dataStall = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, makeBody(200, quoteBody(standardItems, standardMoney), 400)]]);
    const q = deps(dataStall, {timeoutMs: 10});
    q.memo.token = {accessToken: TOKEN, expiresAt: NOW + 86400e3};
    const begun = Date.now();
    assert.equal((await quoteResponse('lunar-dome', params(goodQuery), q)).status, 502);
    assert.ok(Date.now() - begun < 300, `took ${Date.now() - begun} ms`);
    assert.deepEqual(statuses(q), ['timeout']);
  });
}

// Fix 2: concurrent 429s keep the longest cooldown.
test('four workers that hit a 429 together, shortest first, keep the longest cooldown', async () => {
  for (const waits of [['60', '120', '180', '3600'], ['3600', '180', '120', '60'], ['5', '10', '15', '20', '25', '30', '35', '40', '45', '3600']]) {
    const store = memoryStore();
    const queue = [...waits];
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(429, {}, {'retry-after': queue.shift()})]]);
    const make = () => createGuesty({clientId: CLIENT, clientSecret: SECRET, store, fetch: guesty.fetch, now: () => NOW,
      memo: {token: {accessToken: TOKEN, expiresAt: NOW + 86400e3}}, timeoutMs: 50});
    const workers = waits.map(make);
    await Promise.allSettled(workers.map(w => w.get('/api/listings/x/calendar')));
    assert.equal((await store.getWithMetadata('api-backoff')).data.until, NOW + 3600e3, waits.join(','));
    // A fresh worker at second 181 makes no upstream call.
    const before = guesty.calls.length;
    const fresh = createGuesty({clientId: CLIENT, clientSecret: SECRET, store, fetch: guesty.fetch, now: () => NOW + 181e3,
      memo: {token: {accessToken: TOKEN, expiresAt: NOW + 86400e3}}, timeoutMs: 50});
    await assert.rejects(fresh.get('/api/listings/x/calendar'), /rate_limited/);
    assert.equal(guesty.calls.length, before);
  }
});

// Fix 3: nightly prices and included-tax labels, as Guesty sends them.
test('the quote passes through the plan\'s nightly prices and names included taxes without adding them', async () => {
  const stay = {checkIn: '2026-12-10', checkOut: '2026-12-12'};
  const days = [{date: '2026-12-10', price: 100, currency: 'USD', basePrice: 100}, {date: '2026-12-11', price: 150, currency: 'USD'}];
  const items = [{title: 'Accommodation fare', amount: 250, currency: 'USD', includedTaxesList: [{type: 'LOCAL_TAX', normalType: 'LT', title: 'Local tax'}]}];
  const schema = quoteWith({ratePlan: {_id: 'rp', name: 'Standard', days, money: {currency: 'USD', hostPayout: 250, invoiceItems: items}}});
  const expected = {currency: 'USD', ratePlan: '', total: 250, expiresAt: Date.parse(EXPIRES),
    lines: [{title: 'Accommodation fare', amount: 250, included: ['Local tax']}],
    nightly: [{date: '2026-12-10', amount: 100}, {date: '2026-12-11', amount: 150}]};
  assert.deepEqual(mapQuote(schema, stay), expected);
  // The flow guide's layout, days on the entry itself, out of order: same result.
  assert.deepEqual(mapQuote(quoteWith({name: 'Standard', days: [...days].reverse(), money: {currency: 'USD', hostPayout: 250, invoiceItems: items}}), stay), expected);
  // Through the function, for the requested nights.
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, schema)]]);
  const body = await (await quoteResponse('lunar-dome', params({checkIn: stay.checkIn, checkOut: stay.checkOut, guests: '2'}), deps(guesty))).json();
  assert.deepEqual(body.nightly, expected.nightly);
  assert.deepEqual(body.lines, expected.lines);
  assert.equal(body.total, 250);
  // A nightly list that is not exactly this stay's nights, in the plan's currency, refuses the quote.
  const withDays = list => quoteWith({ratePlan: {name: 'Standard', days: list, money: {currency: 'USD', hostPayout: 250, invoiceItems: items}}});
  for (const list of [
    [days[0]],                                                            // a night missing
    [days[0], {...days[1], date: '2026-12-12'}],                          // a night outside the stay
    [days[0], days[0]],                                                   // a repeated night
    [days[0], {...days[1], currency: 'EUR'}],                             // another currency
    [days[0], {...days[1], price: 'x'}], [days[0], {...days[1], price: -1}], [days[0], {...days[1], price: 1.005}],
    'not a list'
  ]) assert.throws(() => mapQuote(withDays(list), stay), /quote_malformed/, JSON.stringify(list));
  // No nightly list: the quote stands without one. An included-tax list that is not a list refuses.
  assert.deepEqual(mapQuote(withDays(undefined), stay).nightly, []);
  assert.throws(() => mapQuote(quoteBody([{...items[0], includedTaxesList: 'Local tax'}], {hostPayout: 250}), stay), /quote_malformed/);
  // An included tax without a name is still named as a tax; duplicates are named once.
  assert.deepEqual(mapQuote(quoteBody([{...items[0], includedTaxesList: [{type: 'X'}, {title: 'Local tax'}, {title: 'Local tax'}]}], {hostPayout: 250}), stay).lines[0].included, ['tax', 'Local tax']);
});

// Fix 6: a calendar that contradicts itself.
test('two different rows for the same night refuse the calendar in either order; identical rows collapse', async () => {
  const open = {date: '2026-12-05', status: 'available', minNights: 2};
  const booked = {date: '2026-12-05', status: 'booked', minNights: 2};
  for (const rows of [[open, booked], [booked, open], [open, {...open, minNights: 3}], [open, {...open, cta: true}]]) {
    assert.throws(() => mapCalendar(rows, '2026-12-01', '2027-11-30'), /calendar_malformed/);
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [CALENDAR_URL, () => json(200, rows)]]);
    const d = deps(guesty);
    const res = await calendarResponse('lunar-dome', d);
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('netlify-cdn-cache-control'), null);
    assert.deepEqual(statuses(d), ['calendar_malformed']);
  }
  assert.deepEqual(mapCalendar([open, {...open}], '2026-12-01', '2027-11-30'),
    [{date: '2026-12-05', available: true, minNights: 2, noArrival: false, noDeparture: false}]);
});

// Blocker 2 and fix 7: the owner script.
test('the owner script sends the documented token request and says to wait 24 hours before anything is sent', async () => {
  const events = [];
  const log = line => events.push(['log', line]);
  const fetchOk = remaining => async (url, init) => {
    events.push(['fetch', String(url)]);
    return json(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN}, {'ratelimit-remaining': remaining});
  };
  const calls = [];
  const recording = async (url, init) => { calls.push({href: String(url), init}); return fetchOk('4')(url, init); };
  assert.equal((await requestOwnerToken({fetch: recording, clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW})).token, TOKEN);
  assertTokenRequest(calls[0]);
  // Even with 4 (or 5) slots left, the instruction is the same 24-hour wait, given before the request.
  for (const remaining of ['4', '5']) {
    events.length = 0;
    await requestOwnerToken({fetch: fetchOk(remaining), clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW});
    assert.equal(events[0][0], 'log');
    assert.equal(events[1][0], 'fetch');
    const text = events.filter(e => e[0] === 'log').map(e => e[1]).join('\n');
    assert.match(events[0][1], /blank until 2026-12-02T18:00:00\.000Z/);
    assert.match(events[0][1], /even if this run fails or stops/);
    assert.doesNotMatch(text, /any time|immediately|may request its first token/i);
  }
  // A request that never answers or is refused: the wait was already printed, and it says so again.
  events.length = 0;
  await assert.rejects(requestOwnerToken({fetch: () => Promise.reject(new DOMException('timed out', 'TimeoutError')), clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW}));
  assert.match(events[0][1], /blank until 2026-12-02T18:00:00\.000Z/);
  await assert.rejects(requestOwnerToken({fetch: async () => json(429, {}), clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW}), /24-hour wait above still applies/);
  // The repo's procedure carries no "go now" exception either.
  const runbook = read('docs/GUESTY_SETUP.md');
  assert.match(runbook, /24 hours/);
  assert.doesNotMatch(runbook + read('scripts/guesty-listings.mjs'), /at least 4|any time after this run/i);
});

// Hardening notes.
test('the owner script refuses a listing reply with fewer listings than the total Guesty states', async () => {
  const one = async () => json(200, {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 10, cursor: {next: null}}});
  await assert.rejects(listAllListings(one, 't'), /says the instance has 10 listing\(s\) but sent 1/);
  const exact = async () => json(200, {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 1, cursor: {next: null}}});
  assert.equal((await listAllListings(exact, 't')).length, 1);
});

test('among several plans, an unnamed cheapest plan is refused rather than shown without its name', () => {
  const fare = amount => [{title: 'Fare', amount, currency: 'USD'}];
  assert.throws(() => mapQuote(quoteWith(schemaPlan('Flexible', fare(500), {hostPayout: 500}), schemaPlan('', fare(450), {hostPayout: 450}))), /quote_ambiguous/);
  assert.throws(() => mapQuote(quoteWith(flowPlan('Flexible', fare(500), {hostPayout: 500}), {days: [], money: {currency: 'USD', hostPayout: 450, invoiceItems: fare(450)}})), /quote_ambiguous/);
  // An unnamed plan that is not the cheapest does not stop the named cheapest one.
  assert.equal(mapQuote(quoteWith(schemaPlan('', fare(500), {hostPayout: 500}), schemaPlan('Non-refundable', fare(450), {hostPayout: 450}))).ratePlan, 'Non-refundable');
  // A single unnamed plan is fine: there is nothing to tell it apart from.
  assert.equal(mapQuote(quoteWith(schemaPlan('', fare(450), {hostPayout: 450}))).total, 450);
});

test('a token 429 waits for the whole Retry-After, beyond 24 hours, in seconds or as a date', () => {
  const res = headers => json(429, {}, headers);
  assert.equal(tokenBackoffMs(429, 0, res({'retry-after': '172800'}), NOW), 172800e3);
  assert.equal(tokenBackoffMs(429, 0, res({'retry-after': new Date(NOW + 30 * 3600e3).toUTCString()}), NOW), 30 * 3600e3);
  assert.equal(tokenBackoffMs(429, 0, res({'retry-after': '60'}), NOW), 15 * 60e3);           // never less than 15 minutes
  assert.equal(tokenBackoffMs(429, 0, res({}), NOW), 3600e3);
});

// ---- Round 3 (review 441r3) ----

// Blocker 1: Guesty's stop, once received, is kept by the same write that lifts the hold.
const stalledBody = headers => init => new Response(new ReadableStream({
  start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason)); }
}), {status: 200, headers});
for (const [name, handler, faults, freeAt] of [
  // Good headers saying no slot is left for 2 hours, then the body stalls past the deadline.
  ['headers that report zero slots, then a stalled body', stalledBody({'ratelimit-remaining': '0', 'ratelimit-reset': '7200'}), {}, 7200e3],
  // Zero slots left and no usable reset: the conservative 24 hours.
  ['a zero balance without a reset', () => json(500, {}, {'ratelimit-remaining': '0'}), {}, 86400e3],
  // A 429 with a 2-hour Retry-After, and only the later cooldown write to the lease fails.
  ['an auth 429 whose lease cooldown write fails', () => json(429, {}, {'retry-after': '7200'}), {'token-lease': n => (n === 2 ? 'throw' : undefined)}, 7200e3]
]) {
  test(`no cold function asks for a token inside Guesty's stop: ${name}`, async () => {
    const guesty = fakeGuesty([[TOKEN_URL, handler]]);
    const d = deps(guesty, {store: memoryStore({faults}), timeoutMs: 15});
    for (const seconds of [0, 181, 550, 3600]) {
      d.tick(seconds * 1000 - (d.now() - NOW));
      await calendarResponse('lunar-dome', {...d, memo: {}});
    }
    assert.equal(guesty.tokenCalls(), 1, 'a token request inside Guesty\'s stop');
    const record = d.store.data.get('token-issuance').value;
    assert.equal(record.hold, undefined, 'the answer was not recorded');
    // Just before the stop ends: still nothing. Just after: one request.
    d.tick(freeAt - 3600e3 - 1e3);
    await calendarResponse('lunar-dome', {...d, memo: {}});
    assert.equal(guesty.tokenCalls(), 1);
    d.tick(2e3);
    await calendarResponse('lunar-dome', {...d, memo: {}});
    assert.equal(guesty.tokenCalls(), 2);
  });
}

test('the token cooldown is written with the answer, in the write that lifts the hold', async () => {
  let seen = null;
  const store = memoryStore();
  const real = store.setJSON.bind(store);
  store.setJSON = async (key, value, options) => {
    if (key === 'token-issuance' && !value.hold) seen = structuredClone(value);
    return real(key, value, options);
  };
  const guesty = fakeGuesty([[TOKEN_URL, () => json(429, {}, {'retry-after': '7200', 'ratelimit-remaining': '0', 'ratelimit-reset': '7200'})]]);
  await calendarResponse('lunar-dome', deps(guesty, {store}));
  assert.equal(seen.retryAt, NOW + 7200e3);
  assert.deepEqual(seen.guesty, {remaining: 0, at: NOW, resetAt: NOW + 7200e3});
});

// Fix 8: a quote's expiry must be a date-time, and its currency one Guesty lists.
test('a quote with an unreadable expiry or a currency Guesty does not list is refused, uncached', async () => {
  const body = extra => ({...quoteBody(standardItems, standardMoney), ...extra});
  for (const [name, quote] of [
    ['expiresAt "2099"', body({expiresAt: '2099'})],
    ['expiresAt without a time', body({expiresAt: '2026-12-02'})],
    ['expiresAt without a zone', body({expiresAt: '2026-12-02T18:00:00'})],
    ['currency ZZZ', quoteWith(schemaPlan('Standard', standardItems.map(item => ({...item, currency: 'ZZZ'})), {...standardMoney, currency: 'ZZZ'}))]
  ]) {
    assert.throws(() => mapQuote(quote, {checkIn: '2026-12-10', checkOut: '2026-12-13'}), /quote_malformed/, name);
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, quote)]]);
    const d = deps(guesty);
    const res = await quoteResponse('lunar-dome', params(goodQuery), d);
    assert.equal(res.status, 502, name);
    assert.equal(res.headers.get('cache-control'), 'no-store', name);
    assert.deepEqual(await res.json(), {ok: false}, name);
    assert.deepEqual(statuses(d), ['quote_malformed'], name);
  }
  // A well-formed but distant expiry is shown no longer than Guesty's 24-hour price hold.
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], [QUOTE_URL, () => json(200, body({expiresAt: '2099-01-01T00:00:00Z'}))]]);
  const res = await quoteResponse('lunar-dome', params(goodQuery), deps(guesty));
  assert.equal((await res.json()).validFor, 86400 - 60 - 600);
  // The documented forms are read: UTC with milliseconds, and an offset.
  assert.equal(mapQuote(body({expiresAt: '2026-12-02T18:00:00.000Z'})).expiresAt, Date.parse('2026-12-02T18:00:00Z'));
  assert.equal(mapQuote(body({expiresAt: '2026-12-02T12:00:00-06:00'})).expiresAt, Date.parse('2026-12-02T18:00:00Z'));
});

// Fix 3: one Guesty listing for two rooms is a setup mistake, refused before it can show a price.
test('a Guesty listing id mapped to two stays gives neither stay live data', async () => {
  const twice = {'lunar-dome': LISTING, 'cloud-dome': ' ' + LISTING};
  assert.equal(resolveStay('lunar-dome', stays, twice).listingId, null);
  assert.equal(resolveStay('cloud-dome', stays, twice).listingId, null);
  assert.equal(resolveStay('lunar-dome', stays, {...twice, 'cloud-dome': ''}).listingId, LISTING);
  const guesty = fakeGuesty([]);
  const d = deps(guesty, {listings: twice});
  assert.equal((await quoteResponse('lunar-dome', params(goodQuery), d)).status, 404);
  assert.equal((await calendarResponse('cloud-dome', d)).status, 404);
  assert.equal(guesty.calls.length, 0);
  assert.deepEqual(statuses(d), ['mapping_conflict', 'mapping_conflict']);
  // The checked-in map repeats no id.
  const ids = Object.values(JSON.parse(read('data/guesty-listings.json'))).map(id => id.trim()).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'data/guesty-listings.json maps one Guesty listing to two stays');
});

// Fix 5: the owner wait is the later of 24 hours and Guesty's own stop.
test('the owner script prints Guesty\'s stop when it is later than the 24-hour wait', async () => {
  const lines = [];
  const log = line => lines.push(line);
  await assert.rejects(requestOwnerToken({fetch: async () => json(429, {}, {'retry-after': '172800', 'ratelimit-remaining': '0'}),
    clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW}), /2026-12-03T18:00:00\.000Z/);
  assert.match(lines[0], /2026-12-02T18:00:00\.000Z/);                     // the first warning stays 24 hours
  // A reset later than 24 hours, on success, also moves the wait.
  lines.length = 0;
  await requestOwnerToken({fetch: async () => json(200, {access_token: TOKEN, expires_in: 86400}, {'ratelimit-remaining': '0', 'ratelimit-reset': String(30 * 3600)}),
    clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW});
  assert.match(lines.join('\n'), /blank until 2026-12-03T00:00:00\.000Z/);
  // An earlier stop changes nothing: 24 hours.
  lines.length = 0;
  await assert.rejects(requestOwnerToken({fetch: async () => json(429, {}, {'retry-after': '60'}), clientId: CLIENT, clientSecret: SECRET, log, now: () => NOW}),
    error => !/2026-12-03/.test(error.message) && /24-hour wait above still applies/.test(error.message));
  assert.match(read('docs/GUESTY_SETUP.md'), /later of/);
});

// Fix 6: the owner script, end to end: the listing pages must carry the bearer Guesty issued.
test('the owner script lists every page with the token it was issued', async () => {
  const ISSUED = 'mock-issued-bearer';
  const pages = {'': {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 2, cursor: {next: 'c2'}}},
    c2: {results: [{_id: 'bbbbbb2', title: 'Cloud Dome'}], pagination: {total: 2, cursor: {next: null}}}};
  const seen = [];
  const fetchMock = async (url, init = {}) => {
    const href = new URL(url);
    if (href.href === TOKEN_URL) return json(200, {token_type: 'Bearer', expires_in: 86400, access_token: ISSUED}, {'ratelimit-remaining': '4'});
    seen.push(init.headers && init.headers.authorization);
    if (!init.headers || init.headers.authorization !== 'Bearer ' + ISSUED) return json(401, {error: 'unauthorized'});
    return json(200, pages[href.searchParams.get('cursor') || '']);
  };
  const lines = [];
  await run({env: {GUESTY_BE_CLIENT_ID: CLIENT, GUESTY_BE_CLIENT_SECRET: SECRET}, fetch: fetchMock, log: line => lines.push(line), now: () => NOW, stays});
  assert.deepEqual(seen, ['Bearer ' + ISSUED, 'Bearer ' + ISSUED]);
  const out = lines.join('\n');
  assert.match(out, /aaaaaa1 {2}Lunar Dome/);
  assert.match(out, /bbbbbb2 {2}Cloud Dome/);
  assert.match(out, /"lunar-dome": "aaaaaa1"/);
});

// Round 4, fix 2: the instruction beside the suggested map names the one effective time (the later
// of 24 hours and Guesty's stop), and the README sends Hank to the guide's "later of" rule.
test('the owner script repeats the effective wait beside the suggested map, and the README defers to the guide', async () => {
  const listing = {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 1, cursor: {next: null}}};
  const owner = async tokenHeaders => {
    const lines = [];
    const fetchMock = async url => (new URL(url).href === TOKEN_URL
      ? json(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN}, tokenHeaders)
      : json(200, listing));
    await run({env: {GUESTY_BE_CLIENT_ID: CLIENT, GUESTY_BE_CLIENT_SECRET: SECRET}, fetch: fetchMock, log: line => lines.push(line), now: () => NOW, stays});
    const out = lines.join('\n');
    return out.slice(out.indexOf('Suggested data/guesty-listings.json'));
  };
  // Guesty's 30-hour reset with no slot left: the map instruction names Dec 3 00:00 UTC, never 24 hours.
  const later = await owner({'ratelimit-remaining': '0', 'ratelimit-reset': String(30 * 3600)});
  assert.match(later, /2026-12-03T00:00:00\.000Z/);
  assert.doesNotMatch(later, /24-hour wait|2026-12-02T18:00/);
  // A normal reply: the 24-hour time printed at the start, repeated.
  const normal = await owner({'ratelimit-remaining': '4'});
  assert.match(normal, /2026-12-02T18:00:00\.000Z/);
  // The README gives no wait of its own: it points to the guide's rule, the later of the two.
  const readme = read('README.md');
  assert.match(readme, /docs\/GUESTY_SETUP\.md/);
  assert.match(readme, /later of/);
  assert.doesNotMatch(readme, /blank for 24 hours/);
});

// Round 5, fix 1: an incomplete listing list (no map printed) still names the effective wait for
// the one retry, and no guide instruction gives a flat 24-hour wait of its own.
test('an incomplete listing list names the later wait for the retry, and the guide never gives a flat 24 hours', async () => {
  const short = {results: [{_id: 'aaaaaa1', title: 'Lunar Dome'}], pagination: {total: 2, cursor: {next: null}}};
  const retry = async tokenHeaders => {
    const lines = [];
    const fetchMock = async url => (new URL(url).href === TOKEN_URL
      ? json(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN}, tokenHeaders)
      : json(200, short));
    const error = await run({env: {GUESTY_BE_CLIENT_ID: CLIENT, GUESTY_BE_CLIENT_SECRET: SECRET}, fetch: fetchMock, log: line => lines.push(line), now: () => NOW, stays})
      .then(() => null, e => e);
    assert.ok(error, 'an incomplete list must stop the run');
    assert.match(error.message, /incomplete/);
    assert.ok(!lines.join('\n').includes('Suggested data/guesty-listings.json'));
    return error.message;
  };
  const later = await retry({'ratelimit-remaining': '0', 'ratelimit-reset': String(30 * 3600)});
  assert.match(later, /before 2026-12-03T00:00:00\.000Z/);
  assert.doesNotMatch(later, /2026-12-02T18:00/);
  assert.match(await retry({'ratelimit-remaining': '4'}), /before 2026-12-02T18:00:00\.000Z/);
  const guide = read('docs/GUESTY_SETUP.md');
  const step4 = guide.slice(guide.indexOf('## 4.'), guide.indexOf('## 5.'));
  assert.match(step4, /incomplete[^\n]*the later of the two/);
  assert.doesNotMatch(guide, /wait the 24 hours|24-hour wait in step 4|new 24-hour wait/);
});

// Round 6, fix 2: a listing request that times out, or a token reply that cannot be read, ends in
// a fresh error that names the operation and the one effective wait (a native timeout's message is
// read-only, so it cannot be appended to), and a later stop is printed as soon as headers arrive.
test('the owner script keeps the operation and the effective wait when a request times out or a reply is unreadable', async () => {
  // A request that never answers: only the script's own timeout signal ends it, with its native reason.
  // The held timer stands in for the open socket: Node 22 does not let AbortSignal.timeout keep the
  // process alive on its own.
  const hang = init => new Promise((resolve, reject) => {
    const socket = setTimeout(() => {}, 10000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  const listingHangs = tokenHeaders => async (url, init = {}) => (new URL(url).href === TOKEN_URL
    ? json(200, {token_type: 'Bearer', expires_in: 86400, access_token: TOKEN}, tokenHeaders)
    : hang(init));
  const owner = async fetchMock => {
    const lines = [];
    const error = await run({env: {GUESTY_BE_CLIENT_ID: CLIENT, GUESTY_BE_CLIENT_SECRET: SECRET}, fetch: fetchMock,
      log: line => lines.push(line), now: () => NOW, stays, timeoutMs: 50}).then(() => null, e => e);
    assert.ok(error, 'the run must stop');
    return {error, out: lines.join('\n')};
  };
  // The native timeout on the listing request: no TypeError about a getter.
  let {error, out} = await owner(listingHangs({'ratelimit-remaining': '4'}));
  assert.equal(error.constructor, Error);
  assert.doesNotMatch(error.message, /getter|Cannot set/);
  assert.match(error.message, /listing request/i);
  assert.match(error.message, /no answer within/);
  assert.match(error.message, /before 2026-12-02T18:00:00\.000Z/);
  assert.ok(!out.includes('Suggested data/guesty-listings.json'));
  // The same timeout after a 30-hour stop names the later time.
  ({error} = await owner(listingHangs({'ratelimit-remaining': '0', 'ratelimit-reset': String(30 * 3600)})));
  assert.match(error.message, /before 2026-12-03T00:00:00\.000Z/);
  assert.doesNotMatch(error.message, /2026-12-02T18:00/);
  // A 200 token reply with a 30-hour stop and an empty body: the later stop is printed before the
  // body is read, and the error repeats it.
  ({error, out} = await owner(async () => json(200, undefined, {'ratelimit-remaining': '0', 'ratelimit-reset': String(30 * 3600)})));
  assert.match(out, /blank until 2026-12-03T00:00:00\.000Z/);
  assert.equal(error.constructor, Error);
  assert.match(error.message, /token reply/i);
  assert.match(error.message, /before 2026-12-03T00:00:00\.000Z/);
  assert.doesNotMatch(error.message, /JSON|Unexpected/);
  // A token request that never answers: the 24-hour time, and the operation.
  ({error, out} = await owner(async (url, init) => hang(init)));
  assert.match(error.message, /token request/i);
  assert.match(error.message, /before 2026-12-02T18:00:00\.000Z/);
  // Nothing secret reaches the error or the terminal.
  for (const text of [error.message, out]) for (const secret of [SECRET, TOKEN]) assert.ok(!text.includes(secret));
});

// Round 6, fix 3: Book takes the tab to Airbnb, so the calendar smoke is two passes: the handoff
// first, then a fresh visit with the block still on, and the retry checked on that page.
test('the guide\'s calendar smoke checks the handoff, then returns to the stay before checking the retry', () => {
  const guide = read('docs/GUESTY_SETUP.md');
  const smoke = guide.slice(guide.indexOf('### Calendar failure and recovery'), guide.indexOf('## 7.'));
  assert.ok(smoke.length > 40, 'step 6 has a calendar failure and recovery smoke');
  const order = ['Pass 1', 'Block request URL', 'Book', 'Airbnb', 'Pass 2', 'still blocked', 'failed', 'Keep this page open', 'unblock', '60 seconds', 'one new', 'unavailable'];
  let at = -1;
  for (const step of order) {
    const next = smoke.indexOf(step, at + 1);
    assert.ok(next > at, `"${step}" comes next in the calendar smoke`);
    at = next;
  }
  assert.doesNotMatch(smoke, /(choose|select|set|switch)[^.\n]*Offline/i);   // only "do not use" it
});
