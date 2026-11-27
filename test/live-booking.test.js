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
// An explicitly empty map, whatever data/guesty-listings.json holds when the suite runs.
const unmapped = mappedBuild(emptyMap);

const D = localDay;
const reply = body => Promise.resolve({ok: true, json: () => Promise.resolve(body)});
const calendar = {ok: true, from: D(0), to: D(364), days: [
  {date: D(10), available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: D(11), available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: D(12), available: false, minNights: 2, noArrival: false, noDeparture: false}]};
const DAY_S = 86400;
// What the quote function sends: the stay and party it was asked for, echoed.
const quoteFor = (checkIn, checkOut, guests, extra = {}) => ({ok: true, checkIn, checkOut, nights: 2, guests: Number(guests), currency: 'USD', ratePlan: '',
  nightly: [{date: checkIn, amount: 180}, {date: D(11), amount: 220}],
  lines: [{title: 'Accommodation fare', amount: 400, included: ['Local tax']}, {title: 'Cleaning fee', amount: 95}, {title: 'Hotel occupancy tax', amount: 49.5}],
  total: 544.5, validFor: DAY_S - 720, ...extra});
const query = url => Object.fromEntries(new URLSearchParams(url.split('?')[1]));
const echo = (extra = {}) => url => {
  if (url.endsWith('/calendar')) return reply(calendar);
  const q = query(url);
  return reply(quoteFor(q.checkIn, q.checkOut, q.guests, typeof extra === 'function' ? extra(q) : extra));
};

// The Book form must hand off to this stay's Airbnb room with the guest's dates and adults, when the
// guest taps the rendered Book button itself (enabled, a submit control of this form).
function assertAirbnbHandoff(p, checkIn, checkOut, adults) {
  assert.equal(p.form.action, airbnbListing(lunar));
  const book = p.form.querySelectorAll('button').filter(b => b.type === 'submit');
  assert.equal(book.length, 1, 'one Book button');
  assert.equal(book[0].disabled, false, 'the Book button is disabled');
  assert.equal(book[0].getAttribute('aria-disabled'), null, 'the Book button is marked disabled');
  const before = p.doc.navigations.length;
  book[0].click();
  assert.equal(p.doc.navigations.length, before + 1, 'tapping Book did not submit the form');
  const sent = new URL(p.doc.navigations.at(-1));
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
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: echo()});
  assert.ok(p.idle());
  await p.settle();
  assert.deepEqual(p.requested, ['/api/stays/lunar-dome/calendar']);
  await p.choose(D(10), D(11));
  assert.match(p.box().textContent, /2-night minimum/);
  assert.equal(p.requested.length, 1);                                       // no quote for dates the calendar rules out
  await p.choose(D(10), D(12), '1');
  assert.equal(p.requested[1], `/api/stays/lunar-dome/quote?checkIn=${D(10)}&checkOut=${D(12)}&guests=1`);
  const shown = p.box().textContent;
  for (const expected of ['Cleaning fee', '$95.00', 'Hotel occupancy tax', '$49.50', 'Total for 2 nights', '$544.50', 'finish booking on Airbnb']) {
    assert.ok(shown.includes(expected), expected);
  }
  // The included tax is named beside its line, and the line keeps its own amount.
  const fare = p.box().querySelectorAll('div').find(row => row.textContent.startsWith('Accommodation fare'));
  assert.equal(fare.textContent, 'Accommodation fare (includes Local tax)$400.00');
  // Guesty's nightly prices are listed by date, apart from the lines and the total.
  const nights = p.box().querySelector('dl.live-nights');
  assert.deepEqual(nights.children.map(row => row.children[1].textContent), ['$180.00', '$220.00']);
  assert.equal(nights.children.length, 2);
  assert.equal(p.box().querySelectorAll('div').filter(row => row.classList.contains('live-total')).length, 1);
  assert.equal(p.box().hidden, false);
  assertAirbnbHandoff(p, D(10), D(12), '1');
});

test('built page: a quote for another party than the one chosen is never shown, and Book still hands off', async () => {
  // A reply for 2 guests when 1 adult is chosen (a stale or mismatched reply).
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: echo({guests: 2})});
  p.idle();
  await p.settle();
  await p.choose(D(10), D(12), '1');
  assert.equal(p.requested.length, 2);
  assert.equal(p.box().hidden, true);
  assert.equal(p.box().textContent, '');
  assertAirbnbHandoff(p, D(10), D(12), '1');
  // A reply for the right party but another stay length, or with no validity, is not shown either.
  for (const extra of [{nights: 3}, {validFor: 0}, {validFor: undefined}]) {
    const other = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: echo(extra)});
    other.idle();
    await other.settle();
    await other.choose(D(10), D(12), '2');
    assert.equal(other.box().hidden, true, JSON.stringify(extra));
  }
});

test('built page: an expired price is taken down on return to the page and asked for again', async () => {
  let price = 305;
  let fail = false;
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url => {
    if (url.endsWith('/calendar')) return reply(calendar);
    if (fail) return Promise.resolve({ok: false, json: () => Promise.resolve({ok: false})});
    const q = query(url);
    return reply(quoteFor(q.checkIn, q.checkOut, q.guests, {nightly: [], lines: [{title: 'Accommodation fare', amount: price}], total: price}));
  }});
  p.idle();
  await p.settle();
  await p.choose(D(10), D(12), '2');
  assert.match(p.box().textContent, /\$305\.00/);
  assert.deepEqual(p.longTimers(), [(DAY_S - 720) * 1000]);                 // the expiry is scheduled
  // The device sleeps 25 hours (no timer runs), then the page is restored from the back/forward cache.
  price = 405;
  await p.advance(25 * 3600e3, {fireTimers: false});
  assert.match(p.box().textContent, /\$305\.00/);                           // nothing has run yet
  await p.fireWindow('pageshow');
  // The day-old availability is asked for again too (round 3, fix 2), then the price.
  assert.deepEqual(p.requested.slice(2).map(url => url.split('?')[0]), ['/api/stays/lunar-dome/calendar', '/api/stays/lunar-dome/quote'], 'a new quote was requested');
  assert.match(p.box().textContent, /\$405\.00/);
  assert.doesNotMatch(p.box().textContent, /\$305/);
  // Expiry by the timer, and a refresh that fails: the old price is hidden, Book still hands off.
  fail = true;
  await p.advance((DAY_S - 720) * 1000);
  assert.equal(p.requested.length, 5);
  assert.equal(p.box().hidden, true);
  assert.equal(p.box().textContent, '');
  assertAirbnbHandoff(p, D(10), D(12), '2');
});

test('built page: a price still within its hold stays on return, and an expired one goes when the tab is shown', async () => {
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: echo({validFor: 600})});
  p.idle();
  await p.settle();
  await p.choose(D(10), D(12), '2');
  await p.advance(300e3, {fireTimers: false});
  await p.fireWindow('pageshow');
  await p.fireDocument('visibilitychange');
  assert.equal(p.requested.length, 2);                                       // still valid: no new request
  assert.match(p.box().textContent, /\$544\.50/);
  await p.advance(301e3, {fireTimers: false});
  await p.fireDocument('visibilitychange');
  assert.equal(p.requested.length, 3);
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

test('built page: a check-in picked before availability arrived, and then found booked, sends the picker back to check-in', async () => {
  let deliver;
  const booked = {ok: true, from: D(0), to: D(364), days: [{date: D(10), available: false, minNights: 1, noArrival: false, noDeparture: false}]};
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url =>
    (url.endsWith('/calendar') ? new Promise(resolve => { deliver = () => resolve({ok: true, json: () => Promise.resolve(booked)}); }) : reply({ok: false}))});
  const prompt = () => p.root.querySelector('[data-calendar-prompt]').textContent;
  p.root.querySelector('[data-calendar-open]').click();
  // The picker opens on this month; page forward when day 10 falls in the next one.
  if (!p.day(D(10))) p.root.querySelector('[data-month="1"]').click();
  p.day(D(10)).click();                                                      // tentative check-in, data still loading
  assert.match(prompt(), /Choose check-out/);
  p.idle();
  deliver();
  await p.settle();
  assert.match(prompt(), /not available.*Choose check-in\.$/);
  assert.doesNotMatch(prompt(), /Choose check-out/);
  assert.equal(p.doc.activeElement, p.day(D(10)));                          // focus back on that day, now marked
  assert.equal(p.day(D(10)).getAttribute('aria-disabled'), 'true');
  // A later day is a check-in again, not a check-out against the booked arrival.
  assert.equal(p.day(D(11)).getAttribute('aria-disabled'), null);
  p.day(D(11)).click();
  assert.match(prompt(), /Check-in .*Choose check-out/);
  p.day(D(13)).click();
  assert.equal(p.form.elements.check_in.value, D(11));
  assert.equal(p.form.elements.check_out.value, D(13));
  // Still valid after the data arrives: the choice is kept.
  let again;
  const q = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url =>
    (url.endsWith('/calendar') ? new Promise(resolve => { again = () => resolve({ok: true, json: () => Promise.resolve(booked)}); }) : reply({ok: false}))});
  q.root.querySelector('[data-calendar-open]').click();
  if (!q.day(D(11))) q.root.querySelector('[data-month="1"]').click();
  q.day(D(11)).click();
  q.idle();
  again();
  await q.settle();
  assert.match(q.root.querySelector('[data-calendar-prompt]').textContent, /Choose check-out/);
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

test('the configured build carries the live script exactly on the stays the checked-in map fills', () => {
  for (const stay of stays) {
    const html = read('dist/stays/' + stay.slug + '/index.html');
    assert.equal(html.includes('data-live='), Boolean(map[stay.slug]), stay.slug);
    assert.equal(html.includes('/live-booking.js'), Boolean(map[stay.slug]), stay.slug);
  }
});

test('an unmapped stay page is exactly today\'s Airbnb handoff', async () => {
  // Built from an explicitly empty map, so the test holds however many stays the real map fills.
  for (const stay of stays) {
    assert.ok(!unmapped[stay.slug].includes('data-live='), stay.slug);
    assert.ok(!unmapped[stay.slug].includes('/live-booking.js'), stay.slug);
  }
  assert.match(bookingPanel({...lunar, live: true}), /<aside class="booking-panel" id="availability" aria-labelledby="booking-title" data-live="\/api\/stays\/lunar-dome">/);
  assert.doesNotMatch(bookingPanel(lunar), /data-live/);
  const p = builtPage('lunar-dome', {html: unmapped['lunar-dome'], fetch: () => { throw new Error('an unmapped page must not fetch'); }});
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

// ---- Round 3 (review 441r3) ----

const failed = () => Promise.resolve({ok: false, json: () => Promise.resolve({ok: false})});
const calendarCalls = p => p.requested.filter(url => url.endsWith('/calendar')).length;
const quoteCalls = p => p.requested.filter(url => url.includes('/quote?')).length;

// Blocker 2: the expiry timer runs on elapsed time; a wall-clock correction must not keep the price.
test('built page: when the expiry timer fires the price goes, even after the device clock was set back', async () => {
  let fail = false;
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url => {
    if (url.endsWith('/calendar')) return reply(calendar);
    if (fail) return failed();
    const q = query(url);
    return reply(quoteFor(q.checkIn, q.checkOut, q.guests, {validFor: 60}));
  }});
  p.idle();
  await p.settle();
  await p.choose(D(10), D(12), '2');
  assert.match(p.box().textContent, /\$544\.50/);
  fail = true;
  p.shiftWall(-10e3);                                                       // the device clock is corrected back 10 s
  await p.advance(61e3);                                                    // the 60 s timer fires; the wall clock says +51 s
  assert.equal(quoteCalls(p), 2, 'the price was not asked for again');
  assert.equal(p.box().hidden, true);
  assert.doesNotMatch(p.box().textContent, /\$544/);
  assertAirbnbHandoff(p, D(10), D(12), '2');
  // On return, a price whose remaining life cannot be told (the clock now reads before its receipt)
  // is taken down and asked for again.
  const q = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: echo({validFor: 600})});
  q.idle();
  await q.settle();
  await q.choose(D(10), D(12), '2');
  assert.match(q.box().textContent, /\$544\.50/);
  q.shiftWall(-3600e3);
  await q.fireWindow('pageshow');
  assert.equal(quoteCalls(q), 2);
});

// Blocker 3: a return after midnight changes the stay; the old price must not outlive it.
test('built page: a return after midnight that clears check-out takes the price down, and a late reply is not shown', async () => {
  const eve = new Date(2026, 11, 1, 23, 55).getTime();                      // 11:55 p.m. local
  const oneNight = q => ({nights: 1, nightly: [], lines: [{title: 'Accommodation fare', amount: 305}], total: 305});
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], now: eve, fetch: echo(oneNight)});
  p.idle();
  await p.settle();
  await p.choose('2026-12-01', '2026-12-02', '2');
  assert.match(p.box().textContent, /\$305\.00/);
  await p.advance(10 * 60e3, {fireTimers: false});                          // 12:05 a.m., back from the bfcache
  await p.fireWindow('pageshow');
  assert.equal(p.form.elements.check_out.value, '');                        // booking.js moved the minimum on
  assert.equal(p.box().hidden, true);
  assert.doesNotMatch(p.box().textContent, /\$305/);
  assert.equal(quoteCalls(p), 1);
  // Back by focus alone (booking.js does not run): the arrival is now in the past, so no price.
  const f = builtPage('lunar-dome', {html: mapped['lunar-dome'], now: eve, fetch: echo(oneNight)});
  f.idle();
  await f.settle();
  await f.choose('2026-12-01', '2026-12-02', '2');
  assert.match(f.box().textContent, /\$305\.00/);
  await f.advance(10 * 60e3, {fireTimers: false});
  await f.fireWindow('focus');
  assert.equal(f.box().hidden, true);
  // A reply that arrives after the stay changed is never rendered.
  let deliver;
  const late = builtPage('lunar-dome', {html: mapped['lunar-dome'], now: eve, fetch: url => {
    if (url.endsWith('/calendar')) return reply(calendar);
    const q = query(url);
    return new Promise(resolve => { deliver = () => resolve({ok: true, json: () => Promise.resolve(quoteFor(q.checkIn, q.checkOut, q.guests, oneNight()))}); });
  }});
  late.idle();
  await late.settle();
  await late.choose('2026-12-01', '2026-12-02', '2');
  await late.advance(10 * 60e3, {fireTimers: false});
  await late.fireWindow('pageshow');
  deliver();
  await late.settle();
  assert.equal(late.box().hidden, true);
  assert.doesNotMatch(late.box().textContent, /\$305/);
});

// Fix 2: availability ages; a returning guest gets it checked again, and a failed check clears it.
test('built page: availability older than 15 minutes is checked again on return and when the picker opens; a failed check clears it', async () => {
  let booked = true;
  let fail = false;
  const live = () => ({ok: true, from: D(0), to: D(364), days: [{date: D(10), available: !booked, minNights: 1, noArrival: false, noDeparture: false}]});
  const p = builtPage('lunar-dome', {html: mapped['lunar-dome'], fetch: url =>
    (url.endsWith('/calendar') ? (fail ? failed() : reply(live())) : reply(quoteFor(D(10), D(12), '2')))});
  const blocked = () => p.ctx.window.stayLive?.dayState(D(10), '').blocked;
  p.idle();
  await p.settle();
  assert.equal(blocked(), true);
  booked = false;                                                           // the night is freed in Guesty
  await p.advance(25 * 3600e3, {fireTimers: false});
  await p.fireWindow('pageshow');
  assert.equal(calendarCalls(p), 2, 'the day-old calendar was not checked again');
  assert.equal(blocked(), false);
  // Still fresh: focus and visibility do not ask again.
  await p.fireWindow('focus');
  await p.fireDocument('visibilitychange');
  assert.equal(calendarCalls(p), 2);
  // Aged again, and the guest opens the picker: checked again, and the open picker is redrawn.
  booked = true;
  await p.advance(16 * 60e3, {fireTimers: false});
  p.root.querySelector('[data-calendar-open]').click();
  await p.settle();
  assert.equal(calendarCalls(p), 3);
  assert.equal(blocked(), true);
  p.dialog().close();
  // Aged, and the check fails: no stale restriction stays, no price, and Book hands off to Airbnb.
  fail = true;
  await p.advance(16 * 60e3, {fireTimers: false});
  await p.fireWindow('focus');
  assert.equal(calendarCalls(p), 4);
  assert.equal(p.ctx.window.stayLive, undefined);
  await p.choose(D(10), D(12), '2');
  assert.equal(p.box().hidden, true);
  assertAirbnbHandoff(p, D(10), D(12), '2');
});
