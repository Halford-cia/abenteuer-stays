// Round 4, fix 3: the URLs the built page requests must reach the deployed Netlify Functions.
// The page's own requests (from a real build with one stay mapped) are routed through the paths
// the functions export in `config.path`, exactly as Netlify matches them, and answered by the
// exported handlers themselves, with Guesty and Netlify Blobs mocked. A request that matches no
// exported route fails here, so a one-character change on either side cannot pass.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { airbnbListing } from '../src/booking.js';
import { builtPage, localDay as D } from './dom-model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const stays = JSON.parse(readFileSync(join(root, 'data/stays.json'), 'utf8'));
const lunar = stays.find(s => s.slug === 'lunar-dome');
const LISTING = 'aaaaaa111111';
const emptyMap = Object.fromEntries(stays.map(s => [s.slug, '']));
const map = {...emptyMap, 'lunar-dome': LISTING};

// The functions import @netlify/blobs and data/guesty-listings.json. In this test the first is an
// in-memory store with ETags and conditional writes, the second the map above (the committed file
// is empty until Hank fills it). Round 5, fix 2: no module loader hooks (module.registerHooks needs
// Node 22.15, and package.json declares >=22). The committed function and library files are copied
// byte for byte into a temporary tree beside the mapped data file and a stub @netlify/blobs package,
// and imported from there, so a change to a committed route still fails here on every Node 22.
const rows = new Map();
let version = 0;
globalThis.routeTestStore = {
  async get(key) { return rows.has(key) ? structuredClone(rows.get(key).data) : null; },
  async getWithMetadata(key) { return rows.has(key) ? {data: structuredClone(rows.get(key).data), etag: rows.get(key).etag, metadata: {}} : null; },
  async setJSON(key, data, options = {}) {
    const previous = rows.get(key);
    if ((options.onlyIfNew && previous) || (options.onlyIfMatch && (!previous || previous.etag !== options.onlyIfMatch))) return {modified: false};
    rows.set(key, {data: structuredClone(data), etag: String(++version)});
    return {modified: true, etag: String(version)};
  }
};
const fnRoot = mkdtempSync(join(tmpdir(), 'stay-eden-functions-'));
test.after(() => rmSync(fnRoot, {recursive: true, force: true}));
cpSync(join(root, 'netlify'), join(fnRoot, 'netlify'), {recursive: true});
cpSync(join(root, 'data'), join(fnRoot, 'data'), {recursive: true});
cpSync(join(root, 'package.json'), join(fnRoot, 'package.json'));   // "type": "module" for netlify/lib/*.js
writeFileSync(join(fnRoot, 'data/guesty-listings.json'), JSON.stringify(map));
mkdirSync(join(fnRoot, 'node_modules/@netlify/blobs'), {recursive: true});
writeFileSync(join(fnRoot, 'node_modules/@netlify/blobs/package.json'), JSON.stringify({name: '@netlify/blobs', type: 'module', exports: './index.js'}));
writeFileSync(join(fnRoot, 'node_modules/@netlify/blobs/index.js'), 'export const getStore = () => globalThis.routeTestStore;\n');
const functionsDir = pathToFileURL(join(fnRoot, 'netlify/functions/')).href;

// Every function the deploy publishes, with the path it registers.
const functions = [];
for (const file of readdirSync(join(root, 'netlify/functions')).filter(f => /\.m?js$/.test(f)).sort()) {
  assert.equal(readFileSync(join(fnRoot, 'netlify/functions', file), 'utf8'), readFileSync(join(root, 'netlify/functions', file), 'utf8'), file);
  const mod = await import(functionsDir + file);
  assert.equal(typeof mod.default, 'function', file);
  assert.equal(typeof mod.config?.path, 'string', file + ' registers no path');
  functions.push({file, mod, path: mod.config.path});
}
// Netlify's path syntax as these functions use it: literal segments and `:name` parameters.
function matchRoute(pathname) {
  const hits = [];
  for (const fn of functions) {
    const names = [];
    const pattern = fn.path.split('/').map(part => {
      if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    const found = new RegExp('^' + pattern + '$').exec(pathname);
    if (found) hits.push({fn, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])]))});
  }
  return hits;
}

// A real build with the map above, in a temporary copy of the site sources.
function buildWith(listings) {
  const dir = mkdtempSync(join(tmpdir(), 'stay-eden-routes-'));
  for (const part of ['src', 'data', 'public', 'netlify/lib', 'package.json']) cpSync(join(root, part), join(dir, part), {recursive: true});
  writeFileSync(join(dir, 'data/guesty-listings.json'), JSON.stringify(listings));
  execFileSync(process.execPath, ['src/build.js'], {cwd: dir, env: {PATH: process.env.PATH}});
  const html = Object.fromEntries(stays.map(s => [s.slug, readFileSync(join(dir, 'dist/stays', s.slug, 'index.html'), 'utf8')]));
  rmSync(dir, {recursive: true, force: true});
  return html;
}
const mapped = buildWith(map);

// Guesty, mocked: the documented addresses, the issued bearer on data calls, and the request body
// the quote function must send for the page's dates and party.
const TOKEN = 'route-test-bearer';
const guesty = {token: 0, calendar: 0, quote: 0, quoteStatus: 200};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  assert.equal(u.origin, 'https://booking.guesty.com');
  if (u.pathname === '/oauth2/token') {
    guesty.token++;
    return json({token_type: 'Bearer', scope: 'booking_engine:api', access_token: TOKEN, expires_in: 86400});
  }
  assert.equal(init.headers.authorization, 'Bearer ' + TOKEN);
  if (u.pathname === `/api/listings/${LISTING}/calendar`) {
    guesty.calendar++;
    return json([10, 11, 12, 13].map(n => ({date: D(n), status: n === 12 ? 'booked' : 'available', minNights: 2, cta: false, ctd: false})));
  }
  assert.equal(u.pathname, '/api/reservations/quotes');
  assert.equal(init.method, 'POST');
  guesty.quote++;
  assert.deepEqual(JSON.parse(init.body), {listingId: LISTING, checkInDateLocalized: D(10), checkOutDateLocalized: D(12), guestsCount: 2});
  if (guesty.quoteStatus !== 200) return json({}, guesty.quoteStatus);
  const now = Date.now();
  return json({_id: 'q1', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400e3).toISOString(), promotions: [], coupons: [],
    rates: {ratePlans: [{ratePlan: {name: 'Standard', money: {currency: 'USD', hostPayout: 264.75,
      invoiceItems: [{title: 'Accommodation fare', amount: 240, currency: 'USD'}, {title: 'Hotel occupancy tax', amount: 24.75, currency: 'USD'}]},
    days: [{date: D(10), price: 110, currency: 'USD'}, {date: D(11), price: 130, currency: 'USD'}]}}]}});
};

// The page's fetch: each URL goes to the one exported function whose path matches it.
const served = [];
let pending = [];
function serve(url) {
  const href = new URL(url, 'https://stay-eden.invalid');
  const hits = matchRoute(href.pathname);
  assert.equal(hits.length, 1, `the page requests ${href.pathname}, which ${hits.length ? 'several functions serve' : 'no deployed function serves'}`);
  const [{fn, params}] = hits;
  const answer = fn.mod.default(new Request(href, {headers: {accept: 'application/json'}}), {params}).then(res => {
    served.push({file: fn.file, path: href.pathname, status: res.status, cache: res.headers.get('cache-control')});
    return res;
  });
  pending.push(answer);
  return answer;
}
async function quiet(p) {
  for (let round = 0; round < 10; round++) {
    const waiting = pending;
    pending = [];
    await Promise.all(waiting);
    await p.settle();
    if (!pending.length) return;
  }
}
const logs = [];
console.log = line => logs.push(String(line));
function credentials(on) {
  if (on) Object.assign(process.env, {GUESTY_BE_CLIENT_ID: 'route-test-id', GUESTY_BE_CLIENT_SECRET: 'route-test-secret-value'});
  else { delete process.env.GUESTY_BE_CLIENT_ID; delete process.env.GUESTY_BE_CLIENT_SECRET; }
}
function assertAirbnbHandoff(p, checkIn, checkOut, adults) {
  const book = p.form.querySelectorAll('button').filter(b => b.type === 'submit');
  assert.equal(book.length, 1);
  assert.equal(book[0].disabled, false);
  book[0].click();
  const sent = new URL(p.doc.navigations.at(-1));
  assert.equal(sent.origin + sent.pathname, airbnbListing(lunar));
  assert.deepEqual([...sent.searchParams], [['check_in', checkIn], ['check_out', checkOut], ['adults', adults]]);
}

test('the deployed functions register the two paths the stay pages are documented to call', () => {
  assert.deepEqual(functions.map(fn => [fn.file, fn.path]),
    [['stay-calendar.mjs', '/api/stays/:slug/calendar'], ['stay-quote.mjs', '/api/stays/:slug/quote']]);
});

test('the built page\'s calendar and quote requests reach the exported handlers, and Guesty\'s price is shown', async () => {
  credentials(true);
  served.length = 0;
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: serve});
  assert.ok(p.idle());
  await quiet(p);
  await p.choose(D(10), D(12), '2');
  await quiet(p);
  assert.deepEqual(served.map(s => [s.file, s.status]), [['stay-calendar.mjs', 200], ['stay-quote.mjs', 200]]);
  assert.deepEqual(p.requested.map(url => url.split('?')[0]), ['/api/stays/lunar-dome/calendar', '/api/stays/lunar-dome/quote']);
  assert.equal(p.ctx.window.stayLive.dayState(D(12), '').blocked, true);    // Guesty's booked night, from the handler
  const shown = p.box().textContent;
  for (const expected of ['Accommodation fare', '$240.00', 'Hotel occupancy tax', '$24.75', '$110.00', '$130.00', 'Total for 2 nights', '$264.75']) assert.ok(shown.includes(expected), expected);
  assert.equal(guesty.token, 1);
  assertAirbnbHandoff(p, D(10), D(12), '2');
});

test('through the same routes, a Guesty failure, missing credentials or an unmapped stay fall back silently', async () => {
  // Guesty refuses the quote: the handler answers 502 uncached, the page shows nothing, Book hands off.
  credentials(true);
  guesty.quoteStatus = 500;
  served.length = 0;
  const failing = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: serve});
  failing.idle();
  await quiet(failing);
  await failing.choose(D(10), D(12), '2');
  await quiet(failing);
  assert.deepEqual(served.map(s => [s.file, s.status]), [['stay-calendar.mjs', 200], ['stay-quote.mjs', 502]]);
  assert.equal(served[1].cache, 'no-store');
  assert.equal(failing.box().hidden, true);
  assert.equal(failing.box().textContent, '');
  assertAirbnbHandoff(failing, D(10), D(12), '2');
  guesty.quoteStatus = 200;

  // No credentials on the deploy: both routes answer 503 before any Guesty call.
  credentials(false);
  const before = {...guesty};
  served.length = 0;
  const bare = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: serve});
  bare.idle();
  await quiet(bare);
  await bare.choose(D(10), D(12), '2');
  await quiet(bare);
  assert.deepEqual(served.map(s => [s.file, s.status, s.cache]), [['stay-calendar.mjs', 503, 'no-store']]);
  assert.equal(bare.ctx.window.stayLive, undefined);
  assert.equal(bare.box().hidden, true);
  assertAirbnbHandoff(bare, D(10), D(12), '2');

  // An unmapped stay: its page carries no live script, and its routes answer 404 with no Guesty call.
  credentials(true);
  const other = stays.find(s => s.slug !== 'lunar-dome');
  assert.equal(mapped[other.slug].includes('data-live='), false);
  served.length = 0;
  for (const kind of ['calendar', 'quote']) {
    const res = await serve(`/api/stays/${other.slug}/${kind}?checkIn=${D(10)}&checkOut=${D(12)}&guests=2`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {ok: false});
  }
  assert.deepEqual([guesty.token, guesty.calendar, guesty.quote], [before.token, before.calendar, before.quote]);
  // Logs carry no credential or token.
  assert.ok(!logs.some(line => /route-test-secret-value|route-test-id|route-test-bearer/.test(line)));
});
