import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGuesty, tokenBackoffMs, GuestyUnavailable, TOKEN_URL } from '../netlify/lib/guesty.js';
import { calendarResponse, quoteResponse, mapQuote, mapCalendar, resolveStay, today } from '../netlify/lib/stay-api.js';
import { suggest } from '../scripts/guesty-listings.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const LISTING = '5bf544a600a9b000389f81d8';
const SECRET = 'client-secret-value';
const TOKEN = 'issued-token-value';
const NOW = Date.parse('2026-12-01T18:00:00Z');

// In-memory stand-in for a Netlify Blobs store, with ETags and conditional writes.
function memoryStore() {
  const data = new Map();
  let version = 0;
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key).value) : null; },
    async getWithMetadata(key) {
      return data.has(key) ? {data: structuredClone(data.get(key).value), etag: data.get(key).etag, metadata: {}} : null;
    },
    async setJSON(key, value, options = {}) {
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

const quoteBody = (items, extra = {}) => ({
  _id: 'q1', createdAt: '2026-12-01T00:00:00Z', expiresAt: '2026-12-02T00:00:00Z', promotions: {}, coupons: [],
  rates: {ratePlans: [{ratePlan: {_id: 'rp1', name: 'Standard', money: {currency: 'USD', invoiceItems: items, ...extra}}}]}
});
const standardItems = [
  {title: 'Accommodation fare', amount: 600, currency: 'USD', type: 'ACCOMMODATION_FARE'},
  {title: 'Cleaning fee', amount: 95, currency: 'USD'},
  {title: 'Hotel occupancy tax', amount: 69.5, currency: 'USD'}
];

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

function deps(guesty, overrides = {}) {
  const lines = [];
  let clock = NOW;
  return {
    lines,
    tick: ms => { clock += ms; },
    env: {GUESTY_BE_CLIENT_ID: 'client-id', GUESTY_BE_CLIENT_SECRET: SECRET},
    store: memoryStore(), fetch: guesty.fetch, now: () => clock, log: line => lines.push(line),
    memo: {}, stays, listings: {'lunar-dome': LISTING}, timeoutMs: 50,
    ...overrides
  };
}
const params = query => new URLSearchParams(query);
const goodQuery = {checkIn: '2026-12-10', checkOut: '2026-12-13', guests: '2'};

test('the token is requested once and reused across calls, instances and until it is near expiry', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [])]]);
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

test('concurrent requests in one instance share a single token request', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [])]]);
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
  assert.match(d.lines.at(-1), /"status":"token_backoff"/);
});

test('a refused token request backs off instead of retrying on every page view', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, () => json(401, {error: 'invalid_client'})]]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  for (let i = 0; i < 5; i++) await calendarResponse('lunar-dome', {...d, memo: {}});
  assert.equal(guesty.tokenCalls(), 1);
  assert.match(d.lines[0], /"status":"token_401"/);
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
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => (rejected ? json(401, {}) : json(200, []))]]);
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

for (const [name, handler] of [
  ['500', () => json(500, {})], ['503', () => json(503, {})], ['malformed body', () => new Response('<html>', {status: 200})],
  ['timeout', init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))],
  ['network error', () => Promise.reject(new TypeError('fetch failed'))]
]) {
  test(`a quote falls back without a price on ${name}`, async () => {
    const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/reservations/quotes', handler]]);
    const d = deps(guesty);
    const res = await quoteResponse('lunar-dome', params(goodQuery), d);
    assert.ok(res.status >= 500);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {ok: false});
  });
}

test('a timeout is logged as a timeout', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk],
    ['/calendar', init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))]]);
  const d = deps(guesty);
  await calendarResponse('lunar-dome', d);
  assert.match(d.lines.at(-1), /"status":"timeout"/);
});

test('the quote carries Guesty\'s own lines, amounts and total, and sends no guest details', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk],
    ['/reservations/quotes', () => json(200, quoteBody(standardItems, {subTotalPrice: 695, totalTaxes: 69.5, totalFees: 95}))]]);
  const d = deps(guesty);
  const res = await quoteResponse('lunar-dome', params(goodQuery), d);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {ok: true, checkIn: '2026-12-10', checkOut: '2026-12-13', nights: 3, guests: 2, currency: 'USD',
    lines: [{title: 'Accommodation fare', amount: 600}, {title: 'Cleaning fee', amount: 95}, {title: 'Hotel occupancy tax', amount: 69.5}],
    total: 764.5, ratePlan: ''});
  const sent = JSON.parse(guesty.calls.find(c => c.href.endsWith('/api/reservations/quotes')).init.body);
  assert.deepEqual(sent, {listingId: LISTING, checkInDateLocalized: '2026-12-10', checkOutDateLocalized: '2026-12-13', guestsCount: 2});
  assert.equal(guesty.calls.find(c => c.href.endsWith('/api/reservations/quotes')).init.method, 'POST');
  assert.match(res.headers.get('netlify-cdn-cache-control'), /s-maxage=300/);
  assert.equal(res.headers.get('netlify-vary'), 'query=checkIn|checkOut|guests');
});

test('quote mapping refuses rather than inventing a price', () => {
  assert.throws(() => mapQuote({rates: {ratePlans: []}}), GuestyUnavailable);
  assert.throws(() => mapQuote(quoteBody([])), /quote_malformed/);
  assert.throws(() => mapQuote(quoteBody([{title: 'Accommodation fare', amount: 'six hundred', currency: 'USD'}])), /quote_malformed/);
  assert.throws(() => mapQuote(quoteBody([{title: 'Fare', amount: 600, currency: 'USD'}, {title: 'Fee', amount: 10, currency: 'EUR'}])), /quote_malformed/);
  assert.throws(() => mapQuote(quoteBody(standardItems, {subTotalPrice: 700, totalTaxes: 69.5})), /quote_total_mismatch/);
  // money beside ratePlan (another reading of the schema) maps the same way.
  const sibling = {rates: {ratePlans: [{ratePlan: {_id: 'a', name: 'Flexible'}, money: {invoiceItems: [{title: 'Fare', amount: 500, currency: 'USD'}]}},
    {ratePlan: {_id: 'b', name: 'Non-refundable', money: {invoiceItems: [{title: 'Fare', amount: 450, currency: 'USD'}]}}}]}};
  assert.deepEqual(mapQuote(sibling), {currency: 'USD', lines: [{title: 'Fare', amount: 450}], total: 450, ratePlan: 'Non-refundable'});
});

test('the calendar maps Guesty statuses, minimum nights and closed arrival or departure days', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [
    {date: '2026-12-02', status: 'available', minNights: 2, cta: false, ctd: true},
    {date: '2026-12-03', status: 'booked', minNights: 2},
    {date: '2026-12-04', status: 'reserved'},
    {date: '2026-12-05', status: 'available', cta: true, minNights: 0},
    {date: 'not-a-date', status: 'available'}
  ])]]);
  const d = deps(guesty);
  const res = await calendarResponse('lunar-dome', d);
  const body = await res.json();
  assert.equal(body.from, '2026-12-01');
  assert.equal(body.to, '2027-11-30');
  assert.ok(guesty.calls.some(c => c.href === `https://booking.guesty.com/api/listings/${LISTING}/calendar?from=2026-12-01&to=2027-11-30`));
  assert.deepEqual(body.days, [
    {date: '2026-12-02', available: true, minNights: 2, noArrival: false, noDeparture: true},
    {date: '2026-12-03', available: false, minNights: 2, noArrival: false, noDeparture: false},
    {date: '2026-12-04', available: false, minNights: 1, noArrival: false, noDeparture: false},
    {date: '2026-12-05', available: true, minNights: 1, noArrival: true, noDeparture: false}
  ]);
  assert.throws(() => mapCalendar({}, '2026-12-01', '2026-12-31'), /calendar_malformed/);
});

test('an unmapped or unknown stay, or missing credentials, never reaches Guesty', async () => {
  const guesty = fakeGuesty([]);
  const d = deps(guesty);
  assert.equal((await calendarResponse('cloud-dome', d)).status, 404);
  assert.equal((await quoteResponse('cloud-dome', params(goodQuery), d)).status, 404);
  assert.equal((await calendarResponse('../etc', d)).status, 404);
  assert.equal((await calendarResponse('lunar-dome', {...d, env: {}})).status, 503);
  assert.equal(guesty.calls.length, 0);
  assert.match(d.lines.join('\n'), /"status":"unmapped"[\s\S]*"status":"unknown_stay"[\s\S]*"status":"not_configured"/);
  assert.equal(resolveStay('lunar-dome', stays, {'lunar-dome': 'not valid!'}).listingId, null);
  assert.equal(resolveStay('lunar-dome', stays, {}).listingId, null);
});

test('quote input is checked before any call to Guesty', async () => {
  const guesty = fakeGuesty([]);
  const d = deps(guesty);
  for (const query of [
    {...goodQuery, checkIn: '2026-11-30'},                              // before today in Texas
    {...goodQuery, checkOut: '2026-12-10'},                             // zero nights
    {...goodQuery, checkIn: '2026-02-30'},                              // not a date
    {...goodQuery, checkOut: '2027-03-01'},                             // longer than 60 nights
    {...goodQuery, guests: '3'},                                        // Lunar Dome sleeps 2
    {...goodQuery, guests: '0'}, {...goodQuery, guests: '1.5'},
    {checkIn: '2029-01-01', checkOut: '2029-01-03', guests: '2'}        // beyond two years
  ]) assert.equal((await quoteResponse('lunar-dome', params(query), d)).status, 400, JSON.stringify(query));
  assert.equal(guesty.calls.length, 0);
});

test('logs carry only the listing id, the dates and a status, never a credential or token', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk],
    ['/reservations/quotes', () => json(200, quoteBody(standardItems))], ['/calendar', () => json(500, {})]]);
  const d = deps(guesty);
  await quoteResponse('lunar-dome', params(goodQuery), d);
  await calendarResponse('lunar-dome', d);
  await quoteResponse('lunar-dome', params({checkIn: 'Jane Doe <jane@example.com>', checkOut: 'x', guests: '2'}), d);
  for (const raw of d.lines) {
    const entry = JSON.parse(raw);
    assert.deepEqual(Object.keys(entry).sort(), entry.fn === 'quote' ? ['checkIn', 'checkOut', 'fn', 'listing', 'status'] : ['fn', 'from', 'listing', 'status', 'to']);
    assert.ok(!raw.includes(SECRET) && !raw.includes(TOKEN) && !raw.includes('jane'));
  }
});

test('without a working token store Guesty is never called (no token without the shared lease)', async () => {
  const guesty = fakeGuesty([[TOKEN_URL, tokenOk], ['/calendar', () => json(200, [])]]);
  const d = deps(guesty, {store: null});
  assert.equal((await calendarResponse('lunar-dome', d)).status, 502);
  assert.equal(guesty.calls.length, 0);
  assert.match(d.lines.at(-1), /"status":"store_error"/);
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
