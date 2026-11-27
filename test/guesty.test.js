import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGuesty, tokenBackoffMs, GuestyUnavailable, TOKEN_URL, TOKEN_ALLOWANCE, sealKey, openToken } from '../netlify/lib/guesty.js';
import { calendarResponse, quoteResponse, mapQuote, mapCalendar, resolveStay, today, addDays } from '../netlify/lib/stay-api.js';
import { suggest, listAllListings, MAX_PAGES } from '../scripts/guesty-listings.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const LISTING = '5bf544a600a9b000389f81d8';
const CLIENT = 'client-id';
const SECRET = 'client-secret-value';
const TOKEN = 'issued-token-value';
const NOW = Date.parse('2026-12-01T18:00:00Z');
const QUOTE_URL = 'https://booking.guesty.com/api/reservations/quotes';
const CALENDAR_URL = `https://booking.guesty.com/api/listings/${LISTING}/calendar?from=2026-12-01&to=2027-11-30`;

// In-memory stand-in for a Netlify Blobs store, with ETags and conditional writes.
// failWrites: keys whose writes throw, as a failing Blobs write would.
function memoryStore({failWrites = []} = {}) {
  const data = new Map();
  let version = 0;
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key).value) : null; },
    async getWithMetadata(key) {
      return data.has(key) ? {data: structuredClone(data.get(key).value), etag: data.get(key).etag, metadata: {}} : null;
    },
    async setJSON(key, value, options = {}) {
      if (failWrites.includes(key)) throw new Error('blobs write failed');
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
const quoteWith = (...ratePlans) => ({_id: 'q1', createdAt: '2026-12-01T00:00:00Z', expiresAt: '2026-12-02T00:00:00Z', promotions: {}, coupons: [], rates: {ratePlans}});
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
  const sent = new URLSearchParams(guesty.calls[0].init.body);
  assert.equal(sent.get('grant_type'), 'client_credentials');
  assert.equal(sent.get('scope'), 'booking_engine:api');
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
    total: 764.5, ratePlan: ''});
  const sent = JSON.parse(guesty.calls.find(c => c.href === QUOTE_URL).init.body);
  assert.deepEqual(sent, {listingId: LISTING, checkInDateLocalized: '2026-12-10', checkOutDateLocalized: '2026-12-13', guestsCount: 2});
  assert.equal(guesty.calls.find(c => c.href === QUOTE_URL).init.method, 'POST');
  assert.match(res.headers.get('netlify-cdn-cache-control'), /s-maxage=300/);
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
  const expected = {currency: 'USD', lines: [{title: 'Fare', amount: 450}], total: 450, ratePlan: 'Non-refundable'};
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
