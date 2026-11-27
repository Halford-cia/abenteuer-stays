// Availability and quotes for the stay pages (Guesty Booking Engine API, phase A: read only).
// No reservation is created here and no guest details are accepted, stored or logged.
// Each log line carries only the listing id, the dates and a status.
import {createGuesty, GuestyUnavailable} from './guesty.js';

export const TIME_ZONE = 'America/Chicago';
export const CALENDAR_DAYS = 365;
export const MAX_NIGHTS = 60;
export const MAX_DAYS_AHEAD = 730;          // Guesty serves calendars up to two years ahead.
const LISTING_ID = /^[A-Za-z0-9]{6,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(value, days) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);

export function today(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(now));
}

// The stay for a slug and its Guesty listing id, or null when the slug is unknown or unmapped.
export function resolveStay(slug, stays, listings) {
  const stay = stays.find(s => s.slug === slug);
  if (!stay) return {stay: null, listingId: null};
  const id = listings && typeof listings[slug] === 'string' ? listings[slug].trim() : '';
  return {stay, listingId: LISTING_ID.test(id) ? id : null};
}

// Guesty's calendar day (API reference, getCalendarByListingId): status is one of four values,
// minNights an integer, cta / ctd booleans that close arrival / departure. A day whose fields are
// missing or outside those types is not a confirmed restriction: the whole calendar is refused
// (silent, uncached Airbnb fallback) rather than shown as taken. An absent minNights, cta or ctd is
// "no restriction known" (null / false), never an invented one.
const STATUSES = new Set(['available', 'unavailable', 'reserved', 'booked']);
const optionalBoolean = value => value === undefined || value === null || typeof value === 'boolean';

export function mapCalendar(body, from, to) {
  if (!Array.isArray(body) || body.length === 0) throw new GuestyUnavailable('calendar_malformed');
  const seen = new Map();
  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || !isDate(entry.date) || !STATUSES.has(entry.status)) throw new GuestyUnavailable('calendar_malformed');
    const hasMin = entry.minNights !== undefined && entry.minNights !== null;
    if (hasMin && !(Number.isInteger(entry.minNights) && entry.minNights > 0)) throw new GuestyUnavailable('calendar_malformed');
    if (!optionalBoolean(entry.cta) || !optionalBoolean(entry.ctd)) throw new GuestyUnavailable('calendar_malformed');
    if (entry.date < from || entry.date > to) continue;
    seen.set(entry.date, {
      date: entry.date,
      available: entry.status === 'available',
      minNights: hasMin ? entry.minNights : null,
      noArrival: entry.cta === true,
      noDeparture: entry.ctd === true
    });
  }
  if (seen.size === 0) throw new GuestyUnavailable('calendar_malformed');
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

const money = value => typeof value === 'number' && Number.isFinite(value);

// Minor units of a currency (USD: 2), from ICU; null for a code Intl does not know.
function precision(currency) {
  try { return new Intl.NumberFormat('en-US', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits; } catch { return null; }
}
// An amount in minor units, or null when it carries more precision than the currency has.
function minor(value, digits) {
  const scaled = value * 10 ** digits;
  const whole = Math.round(scaled);
  return Math.abs(scaled - whole) < 1e-6 ? whole : null;
}

// The two documented layouts of a rate plan entry: the OpenAPI schema nests name and money in
// ratePlans[].ratePlan; the Reservation Quote Flow example puts them on ratePlans[] itself. The
// name, currency and invoice are taken from the same entry.
function planParts(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const inner = entry.ratePlan && typeof entry.ratePlan === 'object' ? entry.ratePlan : null;
  const layer = inner && inner.money ? inner : entry.money ? entry : null;
  if (!layer || !layer.money || typeof layer.money !== 'object') return null;
  const other = layer === inner ? entry : inner;
  const name = [layer.name, other && other.name].find(value => typeof value === 'string' && value.trim()) || '';
  return {name: name.trim().slice(0, 80), money: layer.money};
}

// One rate plan's quote. The total shown is the plan's money.hostPayout, which the Reservation Quote
// Flow names "the total amount the guest will be charged for their stay", in money.currency. The
// invoice lines are shown only when they add up to it exactly, at the currency's precision.
function planQuote(entry) {
  const parts = planParts(entry);
  if (!parts) throw new GuestyUnavailable('quote_malformed');
  const {money: detail, name} = parts;
  const currency = detail.currency;
  const digits = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? precision(currency) : null;
  if (digits === null) throw new GuestyUnavailable('quote_malformed');
  if (!money(detail.hostPayout) || detail.hostPayout <= 0) throw new GuestyUnavailable('quote_malformed');
  const total = minor(detail.hostPayout, digits);
  const items = detail.invoiceItems;
  if (total === null || !Array.isArray(items) || items.length === 0) throw new GuestyUnavailable('quote_malformed');
  const lines = [];
  let sum = 0;
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || !money(item.amount)) throw new GuestyUnavailable('quote_malformed');
    if (item.currency !== undefined && item.currency !== currency) throw new GuestyUnavailable('quote_malformed');
    const amount = minor(item.amount, digits);
    if (amount === null) throw new GuestyUnavailable('quote_total_mismatch');
    sum += amount;
    lines.push({title: item.title.trim().slice(0, 80), amount: amount / 10 ** digits});
  }
  if (sum !== total) throw new GuestyUnavailable('quote_total_mismatch');
  return {currency, lines, total: total / 10 ** digits, minorTotal: total, ratePlan: name};
}

export function mapQuote(body) {
  const plans = body && body.rates && Array.isArray(body.rates.ratePlans) ? body.rates.ratePlans : null;
  if (!plans || plans.length === 0) throw new GuestyUnavailable('quote_malformed');
  // Any plan that cannot be read makes the quote ambiguous: refuse it rather than pick among the rest.
  const quotes = plans.map(planQuote);
  if (new Set(quotes.map(q => q.currency)).size > 1) throw new GuestyUnavailable('quote_currency_mismatch');
  // Several rate plans: show the lowest guest charge and name its plan (open question for Hank).
  quotes.sort((a, b) => a.minorTotal - b.minorTotal);
  const {minorTotal, ...best} = quotes[0];
  return {...best, ratePlan: quotes.length > 1 ? best.ratePlan : ''};
}

function respond(status, body, cacheable) {
  const headers = {'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex'};
  if (cacheable) {
    headers['cache-control'] = 'public, max-age=0, must-revalidate';
    headers['netlify-cdn-cache-control'] = 'public, durable, s-maxage=300, stale-while-revalidate=300';
    if (cacheable !== true) headers['netlify-vary'] = cacheable;
  } else {
    headers['cache-control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), {status, headers});
}

const failure = error => {
  const status = error instanceof GuestyUnavailable ? error.status : 'error';
  const code = status === 'not_configured' ? 503 : /^(token_backoff|token_busy|token_allowance|rate_limited)$/.test(status) ? 503 : 502;
  return {status, code};
};

/**
 * deps: {env, store, fetch, now, log, memo, stays, listings, timeoutMs}
 */
export async function calendarResponse(slug, deps) {
  const {stay, listingId} = resolveStay(slug, deps.stays, deps.listings);
  const from = today(deps.now());
  const to = addDays(from, CALENDAR_DAYS - 1);
  const log = status => deps.log(JSON.stringify({fn: 'calendar', listing: listingId, from, to, status}));
  if (!stay || !listingId) {
    log(stay ? 'unmapped' : 'unknown_stay');
    return respond(404, {ok: false}, false);
  }
  try {
    const guesty = createGuesty({clientId: deps.env.GUESTY_BE_CLIENT_ID, clientSecret: deps.env.GUESTY_BE_CLIENT_SECRET,
      store: deps.store, fetch: deps.fetch, now: deps.now, memo: deps.memo, timeoutMs: deps.timeoutMs});
    const body = await guesty.get(`/api/listings/${encodeURIComponent(listingId)}/calendar?from=${from}&to=${to}`);
    const days = mapCalendar(body, from, to);
    log('ok');
    return respond(200, {ok: true, from, to, days}, true);
  } catch (error) {
    const {status, code} = failure(error);
    log(status);
    return respond(code, {ok: false}, false);
  }
}

export async function quoteResponse(slug, params, deps) {
  const {stay, listingId} = resolveStay(slug, deps.stays, deps.listings);
  const checkIn = params.get('checkIn');
  const checkOut = params.get('checkOut');
  const guests = Number(params.get('guests'));
  const datesValid = isDate(checkIn) && isDate(checkOut);
  const log = status => deps.log(JSON.stringify({fn: 'quote', listing: listingId,
    checkIn: datesValid ? checkIn : null, checkOut: datesValid ? checkOut : null, status}));
  if (!stay || !listingId) {
    log(stay ? 'unmapped' : 'unknown_stay');
    return respond(404, {ok: false}, false);
  }
  const first = today(deps.now());
  const nights = datesValid ? daysBetween(checkIn, checkOut) : 0;
  // The whole stay, check-out included, must fall within the two years Guesty serves.
  if (!datesValid || checkIn < first || daysBetween(first, checkOut) > MAX_DAYS_AHEAD || nights < 1 || nights > MAX_NIGHTS
    || !Number.isInteger(guests) || guests < 1 || guests > stay.guests) {
    log('bad_request');
    return respond(400, {ok: false}, false);
  }
  try {
    const guesty = createGuesty({clientId: deps.env.GUESTY_BE_CLIENT_ID, clientSecret: deps.env.GUESTY_BE_CLIENT_SECRET,
      store: deps.store, fetch: deps.fetch, now: deps.now, memo: deps.memo, timeoutMs: deps.timeoutMs});
    const body = await guesty.post('/api/reservations/quotes', {
      listingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: guests
    });
    const quote = mapQuote(body);
    log('ok');
    return respond(200, {ok: true, checkIn, checkOut, nights, guests, ...quote}, 'query=checkIn|checkOut|guests');
  } catch (error) {
    const {status, code} = failure(error);
    log(status);
    return respond(code, {ok: false}, false);
  }
}
