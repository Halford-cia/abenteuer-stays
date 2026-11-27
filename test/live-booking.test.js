import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bookingPanel } from '../src/booking.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const stays = JSON.parse(read('data/stays.json'));
const map = JSON.parse(read('data/guesty-listings.json'));

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
  {date: '2026-12-15', available: true, minNights: 1, noArrival: false, noDeparture: false}
]);
const plain = value => JSON.parse(JSON.stringify(value));

test('stay rules follow Guesty availability, minimum nights and closed arrival or departure days', () => {
  assert.deepEqual(plain(check(days, '2026-12-10', '2026-12-12')), {ok: true});      // checking out on a booked day is fine
  assert.deepEqual(plain(check(days, '2026-12-10', '2026-12-11')), {ok: false, reason: 'minNights', minNights: 2});
  assert.deepEqual(plain(check(days, '2026-12-11', '2026-12-13')), {ok: false, reason: 'unavailable'});
  assert.deepEqual(plain(check(days, '2026-12-13', '2026-12-15')), {ok: false, reason: 'noArrival'});
  assert.deepEqual(plain(check(days, '2026-12-14', '2026-12-15')), {ok: true});
  assert.deepEqual(plain(check(days, '2026-12-13', '2026-12-14')), {ok: false, reason: 'noArrival'});
  assert.deepEqual(plain(check(days, '2027-06-01', '2027-06-03')), {ok: true});      // outside the calendar: the quote decides
});

test('the calendar blocks the right days for check-in and for check-out', () => {
  assert.equal(dayState(days, '2026-12-12', '').blocked, true);
  assert.equal(dayState(days, '2026-12-13', '').blocked, true);
  assert.equal(dayState(days, '2026-12-14', '').blocked, false);
  assert.equal(dayState(days, '2026-12-11', '2026-12-10').blocked, true);              // under the 2-night minimum
  assert.equal(dayState(days, '2026-12-12', '2026-12-10').blocked, false);
  assert.equal(dayState(days, '2026-12-13', '2026-12-10').blocked, true);              // crosses a booked night
});

// A minimal DOM model: enough of document, the booking form and fetch to drive the script.
function page(fetchImpl) {
  class Node {
    constructor(tag) { Object.assign(this, {tag, children: [], className: '', textContent: '', hidden: false, attrs: {}}); }
    setAttribute(name, value) { this.attrs[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    after(node) { this.next = node; }
  }
  const text = node => [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
  const listeners = {};
  const nights = new Node('output');
  const form = {elements: {check_in: {value: ''}, check_out: {value: ''}, adults: {value: '2'}},
    querySelector: () => nights, addEventListener: (type, fn) => { listeners[type] = fn; }};
  const panel = {dataset: {live: '/api/stays/lunar-dome'}, querySelector: () => form};
  const requested = [];
  let idle;
  const ctx = {URLSearchParams, Intl, AbortController, setTimeout, clearTimeout,
    document: {querySelector: () => panel, createElement: tag => new Node(tag)},
    requestIdleCallback: fn => { idle = fn; },
    fetch: (url, init) => { requested.push(url); return fetchImpl(url, init); }};
  ctx.window = ctx;
  vm.runInNewContext(read('public/live-booking.js'), ctx);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return {ctx, form, requested, box: () => nights.next, text, settle,
    load: async () => { idle(); await settle(); },
    choose: async (checkIn, checkOut) => { form.elements.check_in.value = checkIn; form.elements.check_out.value = checkOut; listeners.change(); await settle(); }};
}
const reply = body => Promise.resolve({ok: true, json: () => Promise.resolve(body)});
const calendar = {ok: true, from: '2026-12-01', to: '2027-11-30', days: [
  {date: '2026-12-10', available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: '2026-12-11', available: true, minNights: 2, noArrival: false, noDeparture: false},
  {date: '2026-12-12', available: false, minNights: 2, noArrival: false, noDeparture: false}]};

test('in the DOM model a valid stay shows Guesty\'s lines and total; the Book form is untouched', async () => {
  const quote = {ok: true, checkIn: '2026-12-10', checkOut: '2026-12-12', nights: 2, guests: 2, currency: 'USD', ratePlan: '',
    lines: [{title: 'Accommodation fare', amount: 400}, {title: 'Cleaning fee', amount: 95}, {title: 'Hotel occupancy tax', amount: 49.5}], total: 544.5};
  const p = page(url => reply(url.includes('/calendar') ? calendar : quote));
  await p.load();
  assert.equal(p.ctx.window.stayLive.minNights('2026-12-10'), 2);
  assert.equal(p.ctx.window.stayLive.dayState('2026-12-12', '').blocked, true);
  await p.choose('2026-12-10', '2026-12-11');
  assert.match(p.text(p.box()), /2-night minimum/);
  assert.equal(p.requested.length, 1);                                       // no quote for dates the calendar rules out
  await p.choose('2026-12-10', '2026-12-12');
  assert.equal(p.requested[1], '/api/stays/lunar-dome/quote?checkIn=2026-12-10&checkOut=2026-12-12&guests=2');
  const shown = p.text(p.box());
  for (const expected of ['Accommodation fare', '$400.00', 'Cleaning fee', '$95.00', 'Hotel occupancy tax', '$49.50', 'Total for 2 nights', '$544.50', 'finish booking on Airbnb']) {
    assert.ok(shown.includes(expected), expected);
  }
  assert.equal(p.box().hidden, false);
});

test('in the DOM model any failed call leaves no quote and no message', async () => {
  for (const failing of [() => Promise.reject(new TypeError('offline')), () => Promise.resolve({ok: false, json: () => Promise.resolve({ok: false})})]) {
    const p = page(url => (url.includes('/calendar') ? reply(calendar) : failing()));
    await p.load();
    await p.choose('2026-12-10', '2026-12-12');
    assert.equal(p.box().hidden, true);
    assert.equal(p.text(p.box()), '');
    const down = page(failing);
    await down.load();
    assert.equal(down.ctx.window.stayLive, undefined);                       // the calendar works exactly as before
    await down.choose('2026-12-10', '2026-12-12');
    assert.equal(down.requested.length, 1);
    assert.equal(down.box().hidden, true);
  }
});

test('an unmapped stay page is exactly today\'s Airbnb handoff', () => {
  for (const stay of stays) {
    const html = read('dist/stays/' + stay.slug + '/index.html');
    assert.equal(html.includes('data-live='), Boolean(map[stay.slug]));
    assert.equal(html.includes('/live-booking.js'), Boolean(map[stay.slug]));
  }
  const stay = stays.find(s => s.slug === 'lunar-dome');
  assert.match(bookingPanel({...stay, live: true}), /<aside class="booking-panel" id="availability" aria-labelledby="booking-title" data-live="\/api\/stays\/lunar-dome">/);
  assert.doesNotMatch(bookingPanel(stay), /data-live/);
});

test('guest-facing code never holds a Guesty credential or calls Guesty directly', () => {
  for (const file of ['public/live-booking.js', 'public/booking.js', 'public/site.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /guesty\.com|GUESTY_BE_|client_secret/i, file);
  }
  assert.match(read('netlify.toml'), /CONTENT-SECURITY-POLICY|Content-Security-Policy = "default-src 'self'/i);
});
