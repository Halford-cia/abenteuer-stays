import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { airbnbListing, bookingPanel } from '../src/booking.js';
import { builtPage, localDay } from './dom-model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const map = JSON.parse(read('data/guesty-listings.json'));
const lunar = stays.find(s => s.slug === 'lunar-dome');

// Run the browser script without a DOM; it exposes only its pure availability rules.
const context = {URLSearchParams, Intl};
vm.runInNewContext(read('public/live-booking.js'), context);
const {check, dayState, index} = context.stayLiveRules;
const days = index([
  {date: '2026-12-10', available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: '2026-12-11', available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: '2026-12-12', available: false, minNights: 2, noArrival: false, noDeparture: false},
  {date: '2026-12-13', available: true, minNights: 1, noArrival: true, noDeparture: false},
  {date: '2026-12-14', available: true, minNights: 1, noArrival: false, noDeparture: true},
  {date: '2026-12-15', available: true, minNights: 1, noArrival: false, noDeparture: false},
  {date: '2026-12-16', available: true, minNights: null, noArrival: false, noDeparture: true},
  {date: '2026-12-17', available: true, minNights: null, noArrival: false, noDeparture: false}
]);
const plain = value => JSON.parse(JSON.stringify(value));

test('stay rules follow Guesty availability, minimum nights and closed arrival or departure days', () => {
  assert.deepEqual(plain(check(days, '2026-12-10', '2026-12-12')), {ok: true});      // checking out on a booked day is fine
  assert.deepEqual(plain(check(days, '2026-12-10', '2026-12-11')), {ok: false, reason: 'minNights', minNights: 2});
  assert.deepEqual(plain(check(days, '2026-12-11', '2026-12-13')), {ok: false, reason: 'unavailable'});
  assert.deepEqual(plain(check(days, '2026-12-13', '2026-12-15')), {ok: false, reason: 'noArrival'});
  assert.deepEqual(plain(check(days, '2026-12-14', '2026-12-15')), {ok: true});
  // An otherwise valid stay (open arrival, open nights, minimum met) that ends on a closed departure.
  assert.deepEqual(plain(check(days, '2026-12-15', '2026-12-16')), {ok: false, reason: 'noDeparture'});
  assert.deepEqual(plain(check(days, '2026-12-15', '2026-12-17')), {ok: true});
  // An unknown minimum (null) is no restriction: one night is fine.
  assert.deepEqual(plain(check(days, '2026-12-16', '2026-12-17')), {ok: true});
  assert.deepEqual(plain(check(days, '2027-06-01', '2027-06-03')), {ok: true});      // outside the calendar: the quote decides
});

test('the calendar blocks the right days for check-in and for check-out', () => {
  assert.equal(dayState(days, '2026-12-12', '').blocked, true);
  assert.equal(dayState(days, '2026-12-13', '').blocked, true);
  assert.equal(dayState(days, '2026-12-14', '').blocked, false);
  assert.equal(dayState(days, '2026-12-11', '2026-12-10').blocked, true);              // under the 2-night minimum
  assert.equal(dayState(days, '2026-12-12', '2026-12-10').blocked, false);
  assert.equal(dayState(days, '2026-12-13', '2026-12-10').blocked, true);              // crosses a booked night
  assert.equal(dayState(days, '2026-12-16', '2026-12-15').blocked, true);              // closed to departure
  assert.equal(dayState(days, '2026-12-17', '2026-12-15').blocked, false);
});

// A real build with one stay mapped, in a temporary copy of the site sources.
function mappedBuild(listings) {
  const dir = mkdtempSync(join(tmpdir(), 'stay-eden-build-'));
  for (const part of ['src', 'data', 'public', 'netlify/lib', 'package.json']) cpSync(join(root, part), join(dir, part), {recursive: true});
  writeFileSync(join(dir, 'data/guesty-listings.json'), JSON.stringify(listings));
  execFileSync(process.execPath, ['src/build.js'], {cwd: dir, env: {PATH: process.env.PATH}});
  const html = Object.fromEntries(stays.map(s => [s.slug, readFileSync(join(dir, 'dist/stays', s.slug, 'index.html'), 'utf8')]));
  rmSync(dir, {recursive: true, force: true});
  return html;
}
const emptyMap = Object.fromEntries(stays.map(s => [s.slug, '']));
const mapped = mappedBuild({...emptyMap, 'lunar-dome': 'aaaaaa111111'});

const D = localDay;
const reply = body => Promise.resolve({ok: true, json: () => Promise.resolve(body)});
const calendar = {ok: true, from: D(0), to: D(364), days: [
  {date: D(10), available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: D(11), available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: D(12), available: false, minNights: 2, noArrival: false, noDeparture: false}]};
const quoteFor = (checkIn, checkOut) => ({ok: true, checkIn, checkOut, nights: 2, guests: 2, currency: 'USD', ratePlan: '',
  lines: [{title: 'Accommodation fare', amount: 400}, {title: 'Cleaning fee', amount: 95}, {title: 'Hotel occupancy tax', amount: 49.5}], total: 544.5});

// The Book form must hand off to this stay's Airbnb room with the guest's dates and adults.
function assertAirbnbHandoff(p, checkIn, checkOut, adults) {
  assert.equal(p.form.action, airbnbListing(lunar));
  const url = p.form.requestSubmit();
  assert.ok(url, 'the submit was prevented');
  const sent = new URL(url);
  assert.equal(sent.origin + sent.pathname, airbnbListing(lunar));
  assert.deepEqual([...sent.searchParams], [['check_in', checkIn], ['check_out', checkOut], ['adults', adults]]);
}

test('only the mapped stay carries the live script; the rest of the mapped build is today\'s page', () => {
  for (const stay of stays) {
    assert.equal(mapped[stay.slug].includes('/live-booking.js'), stay.slug === 'lunar-dome', stay.slug);
    assert.equal(mapped[stay.slug].includes('data-live='), stay.slug === 'lunar-dome', stay.slug);
  }
  assert.deepEqual(builtPage('lunar-dome', {html: mapped['lunar-dome']}).scripts, ['booking.js', 'live-booking.js']);
});

test('built page, quote success: Guesty\'s lines and total show, and Book submits the Airbnb form with the dates', async () => {
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url =>
    reply(url.endsWith('/calendar') ? calendar : quoteFor(new URLSearchParams(url.split('?')[1]).get('checkIn'), new URLSearchParams(url.split('?')[1]).get('checkOut')))});
  assert.ok(p.idle());
  await p.settle();
  assert.deepEqual(p.requested, ['/api/stays/lunar-dome/calendar']);
  await p.choose(D(10), D(11));
  assert.match(p.box().textContent, /2-night minimum/);
  assert.equal(p.requested.length, 1);                                       // no quote for dates the calendar rules out
  await p.choose(D(10), D(12), '1');
  assert.equal(p.requested[1], `/api/stays/lunar-dome/quote?checkIn=${D(10)}&checkOut=${D(12)}&guests=1`);
  const shown = p.box().textContent;
  for (const expected of ['Accommodation fare', '$400.00', 'Cleaning fee', '$95.00', 'Hotel occupancy tax', '$49.50', 'Total for 2 nights', '$544.50', 'finish booking on Airbnb']) {
    assert.ok(shown.includes(expected), expected);
  }
  assert.equal(p.box().hidden, false);
  assertAirbnbHandoff(p, D(10), D(12), '1');
});

test('built page, calendar failure: no live state, no quote request, and Book still submits to Airbnb', async () => {
  for (const failing of [() => Promise.reject(new TypeError('offline')), () => Promise.resolve({ok: false, json: () => Promise.resolve({ok: false})})]) {
    const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: failing});
    p.idle();
    await p.settle();
    assert.equal(p.ctx.window.stayLive, undefined);
    await p.choose(D(10), D(12));
    assert.deepEqual(p.requested, ['/api/stays/lunar-dome/calendar']);
    assert.equal(p.box().hidden, true);
    assert.equal(p.box().textContent, '');
    assertAirbnbHandoff(p, D(10), D(12), '2');
  }
});

test('built page, quote failure: no price and no message, and Book still submits to Airbnb', async () => {
  for (const failing of [() => Promise.reject(new TypeError('offline')), () => Promise.resolve({ok: false, json: () => Promise.resolve({ok: false})})]) {
    const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url => (url.endsWith('/calendar') ? reply(calendar) : failing())});
    p.idle();
    await p.settle();
    await p.choose(D(10), D(12));
    assert.equal(p.requested.length, 2);
    assert.match(p.requested[1], /\/quote\?/);
    assert.equal(p.box().hidden, true);
    assert.equal(p.box().textContent, '');
    assertAirbnbHandoff(p, D(10), D(12), '2');
  }
});

test('built page: availability that arrives while the picker is open redraws it, keeps focus, and a booked day cannot be picked', async () => {
  let deliver;
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url =>
    (url.endsWith('/calendar') ? new Promise(resolve => { deliver = () => resolve({ok: true, json: () => Promise.resolve(open)}); }) : reply({ok: false}))});
  const open = {ok: true, from: D(0), to: D(364), days: [{date: D(0), available: false, minNights: 1, noArrival: false, noDeparture: false}]};
  p.root.querySelector('[data-calendar-open]').click();
  assert.equal(p.dialog().open, true);
  assert.equal(p.doc.activeElement.dataset.day, D(0));                      // focus on today, not yet known to be booked
  assert.equal(p.day(D(0)).getAttribute('aria-disabled'), null);
  p.idle();
  deliver();
  await p.settle();
  const today = p.day(D(0));
  assert.equal(today.getAttribute('aria-disabled'), 'true');
  assert.match(today.getAttribute('aria-label'), /not available/);
  assert.equal(p.doc.activeElement, today);                                  // focus kept on the same day
  today.click();
  assert.match(p.root.querySelector('[data-calendar-prompt]').textContent, /^Choose check-in/);
  assert.equal(p.form.elements.check_in.value, '');
});

test('built page: a click is checked against the current rule, even on a day drawn before the rule arrived', async () => {
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: () => new Promise(() => {})});
  p.root.querySelector('[data-calendar-open]').click();
  const drawn = p.day(D(0));
  assert.equal(drawn.getAttribute('aria-disabled'), null);
  // The rule is known but the open grid was not redrawn.
  p.ctx.window.stayLive = {dayState: value => ({blocked: value === D(0)}), minNights: () => 1};
  drawn.click();
  assert.match(p.root.querySelector('[data-calendar-prompt]').textContent, /^Choose check-in/);
});

test('an unmapped stay page is exactly today\'s Airbnb handoff', async () => {
  for (const stay of stays) {
    const html = read('dist/stays/' + stay.slug + '/index.html');
    assert.equal(html.includes('data-live='), Boolean(map[stay.slug]));
    assert.equal(html.includes('/live-booking.js'), Boolean(map[stay.slug]));
  }
  assert.match(bookingPanel({...lunar, live: true}), /<aside class="booking-panel" id="availability" aria-labelledby="booking-title" data-live="\/api\/stays\/lunar-dome">/);
  assert.doesNotMatch(bookingPanel(lunar), /data-live/);
  const p = builtPage('lunar-dome', {fetch: () => { throw new Error('an unmapped page must not fetch'); }});
  assert.deepEqual(p.scripts, ['booking.js']);
  await p.choose(D(10), D(12));
  assert.deepEqual(p.requested, []);
  assertAirbnbHandoff(p, D(10), D(12), '2');
});

test('guest-facing code never holds a Guesty credential or calls Guesty directly', () => {
  for (const file of ['public/live-booking.js', 'public/booking.js', 'public/site.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /guesty\.com|GUESTY_BE_|client_secret/i, file);
  }
  assert.match(read('netlify.toml'), /CONTENT-SECURITY-POLICY|Content-Security-Policy = "default-src 'self'/i);
});
