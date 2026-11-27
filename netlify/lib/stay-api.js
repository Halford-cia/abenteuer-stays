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
// One Guesty listing mapped to two stays is a setup mistake (the two rooms would show one
// property's dates and price): neither stay gets live data until the map is corrected (conflict).
const mappedId = (listings, slug) => (listings && typeof listings[slug] === 'string' ? listings[slug].trim() : '');
export function resolveStay(slug, stays, listings) {
  const stay = stays.find(s => s.slug === slug);
  if (!stay) return {stay: null, listingId: null};
  const id = mappedId(listings, slug);
  if (!LISTING_ID.test(id)) return {stay, listingId: null};
  const conflict = Object.keys(listings).some(other => other !== slug && mappedId(listings, other) === id);
  return conflict ? {stay, listingId: null, conflict: true} : {stay, listingId: id};
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
    const day = {
      date: entry.date,
      available: entry.status === 'available',
      minNights: hasMin ? entry.minNights : null,
      noArrival: entry.cta === true,
      noDeparture: entry.ctd === true
    };
    // Two rows for one date: identical ones collapse; any difference (status, minimum, closures)
    // means Guesty's reply contradicts itself, and the whole calendar is refused.
    const fingerprint = JSON.stringify([entry.status, day.minNights, day.noArrival, day.noDeparture]);
    const earlier = seen.get(entry.date);
    if (earlier && earlier.fingerprint !== fingerprint) throw new GuestyUnavailable('calendar_malformed');
    seen.set(entry.date, {day, fingerprint});
  }
  if (seen.size === 0) throw new GuestyUnavailable('calendar_malformed');
  return [...seen.values()].map(entry => entry.day).sort((a, b) => (a.date < b.date ? -1 : 1));
}

const money = value => typeof value === 'number' && Number.isFinite(value);

// The money currencies Guesty lists for a quote (createReservationQuote response,
// rates.ratePlans[].ratePlan.money.currency and invoiceItems[].currency, read 2026-11-27).
export const GUESTY_CURRENCIES = new Set(['USD', 'EUR', 'AUD', 'CAD', 'JPY', 'ILS', 'GBP', 'HKD', 'NOK', 'CZK', 'BRL',
  'CHF', 'THB', 'ZAR', 'MYR', 'KRW', 'IDR', 'PHP', 'INR', 'NZD', 'TWD', 'PLN', 'SGD', 'TRY', 'SEK', 'VND', 'ARS', 'CNY', 'DKK', 'MXN']);

// expiresAt is a date-time (OpenAPI format date-time, RFC 3339): full date, time with seconds, and
// a zone. Anything else ("2099", a bare date, a local time) is not a readable expiry.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
function dateTime(value) {
  if (typeof value !== 'string' || !DATE_TIME.test(value) || !isDate(value.slice(0, 10))) return NaN;
  return Date.parse(value);
}

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

// The two documented layouts of a rate plan entry: the OpenAPI schema nests name, days and money in
// ratePlans[].ratePlan; the Reservation Quote Flow example puts them on ratePlans[] itself. The
// name, nightly days, currency and invoice are taken from the same entry.
function planParts(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const inner = entry.ratePlan && typeof entry.ratePlan === 'object' ? entry.ratePlan : null;
  const layer = inner && inner.money ? inner : entry.money ? entry : null;
  if (!layer || !layer.money || typeof layer.money !== 'object') return null;
  const other = layer === inner ? entry : inner;
  const name = [layer.name, other && other.name].find(value => typeof value === 'string' && value.trim()) || '';
  const days = layer.days !== undefined && layer.days !== null ? layer.days : other ? other.days : undefined;
  return {name: name.trim().slice(0, 80), money: layer.money, days};
}

const malformed = () => new GuestyUnavailable('quote_malformed');

// The plan's dated nightly prices (ratePlan.days[].date / price / currency), shown as Guesty sends
// them. Absent or empty: no nightly breakdown. Present: exactly one row per night of the requested
// stay, each a finite non-negative price in the plan's currency at its precision, or the quote is
// refused (a nightly list for other dates means the quote is not for this stay).
function nightlyRates(days, currency, digits, stay) {
  if (days === undefined || days === null || (Array.isArray(days) && days.length === 0)) return [];
  if (!Array.isArray(days) || !stay) throw malformed();
  const nights = [];
  for (let night = stay.checkIn; night < stay.checkOut; night = addDays(night, 1)) nights.push(night);
  if (days.length !== nights.length) throw malformed();
  const rows = days.map(day => {
    if (!day || typeof day !== 'object' || !isDate(day.date) || !money(day.price) || day.price < 0) throw malformed();
    if (day.currency !== undefined && day.currency !== null && day.currency !== currency) throw malformed();
    const amount = minor(day.price, digits);
    if (amount === null) throw malformed();
    return {date: day.date, amount: amount / 10 ** digits};
  }).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.some((row, i) => row.date !== nights[i])) throw malformed();
  return rows;
}

// Names of the taxes already inside an invoice line (invoiceItems[].includedTaxesList[].title,
// changelog 2026-02-15). They are labels only: the line's amount already holds them.
function includedTaxes(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw malformed();
  const names = list.map(tax => (tax && typeof tax.title === 'string' && tax.title.trim() ? tax.title.trim().slice(0, 80) : 'tax'));
  return [...new Set(names)];
}

// One rate plan's quote. The total shown is the plan's money.hostPayout, which the Reservation Quote
// Flow names "the total amount the guest will be charged for their stay", in money.currency. The
// invoice lines are shown only when they add up to it exactly, at the currency's precision.
function planQuote(entry, stay) {
  const parts = planParts(entry);
  if (!parts) throw malformed();
  const {money: detail, name} = parts;
  const currency = detail.currency;
  const digits = GUESTY_CURRENCIES.has(currency) ? precision(currency) : null;
  if (digits === null) throw malformed();
  if (!money(detail.hostPayout) || detail.hostPayout <= 0) throw malformed();
  const total = minor(detail.hostPayout, digits);
  const items = detail.invoiceItems;
  if (total === null || !Array.isArray(items) || items.length === 0) throw malformed();
  const lines = [];
  let sum = 0;
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || !money(item.amount)) throw malformed();
    if (item.currency !== undefined && item.currency !== currency) throw malformed();
    const amount = minor(item.amount, digits);
    if (amount === null) throw new GuestyUnavailable('quote_total_mismatch');
    sum += amount;
    const line = {title: item.title.trim().slice(0, 80), amount: amount / 10 ** digits};
    const included = includedTaxes(item.includedTaxesList);
    if (included.length) line.included = included;
    lines.push(line);
  }
  if (sum !== total) throw new GuestyUnavailable('quote_total_mismatch');
  const nightly = nightlyRates(parts.days, currency, digits, stay);
  return {currency, lines, nightly, total: total / 10 ** digits, minorTotal: total, ratePlan: name};
}

// stay: {checkIn, checkOut}, the requested dates, used to check the plan's nightly rows.
export function mapQuote(body, stay) {
  const plans = body && body.rates && Array.isArray(body.rates.ratePlans) ? body.rates.ratePlans : null;
  if (!plans || plans.length === 0) throw malformed();
  // Guesty's quote holds its prices until expiresAt (required in the schema; the flow guide: 24 hours).
  const expiresAt = dateTime(body.expiresAt);
  if (!Number.isFinite(expiresAt)) throw malformed();
  // Any plan that cannot be read makes the quote ambiguous: refuse it rather than pick among the rest.
  const quotes = plans.map(plan => planQuote(plan, stay));
  if (new Set(quotes.map(q => q.currency)).size > 1) throw new GuestyUnavailable('quote_currency_mismatch');
  // Several rate plans: show the lowest guest charge and name its plan (open question for Hank).
  quotes.sort((a, b) => a.minorTotal - b.minorTotal);
  const {minorTotal, ...best} = quotes[0];
  // Among several plans, an unnamed one cannot be told apart from the others (refundable or not):
  // refuse rather than show its price without saying which offer it is.
  if (quotes.length > 1 && !best.ratePlan) throw new GuestyUnavailable('quote_ambiguous');
  return {...best, ratePlan: quotes.length > 1 ? best.ratePlan : '', expiresAt};
}

// How long a quote may be cached and shown, from Guesty's expiresAt and the server clock.
// The CDN keeps it at most QUOTE_CDN_FRESH + QUOTE_CDN_STALE seconds, never past the expiry less a
// margin, and the reply tells the browser how many seconds it may show the price after receiving it
// (validFor), already less the longest time the reply may have sat in the CDN. A relative figure,
// so a wrong clock on the guest's device cannot stretch it. null: too close to expiry to show.
// The flow guide guarantees a quote's prices for 24 hours, so a later expiresAt is never trusted
// beyond that.
export const QUOTE_EXPIRY_MARGIN = 60;
export const QUOTE_MIN_SHOW = 60;
const QUOTE_CDN_FRESH = 300;
const QUOTE_CDN_STALE = 300;
const QUOTE_HOLD_MAX = 86400e3;
export function quoteLifetime(expiresAt, now) {
  const usable = Math.floor((Math.min(expiresAt, now + QUOTE_HOLD_MAX) - now) / 1000) - QUOTE_EXPIRY_MARGIN;
  if (!(usable >= QUOTE_MIN_SHOW)) return null;
  const cached = Math.min(QUOTE_CDN_FRESH + QUOTE_CDN_STALE, usable - QUOTE_MIN_SHOW);
  const sMaxAge = Math.min(QUOTE_CDN_FRESH, cached);
  return {sMaxAge, staleWhileRevalidate: cached - sMaxAge, validFor: usable - cached};
}

// cache: null (no-store) or {sMaxAge, staleWhileRevalidate, vary}.
function respond(status, body, cache) {
  const headers = {'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex'};
  if (cache && cache.sMaxAge > 0) {
    headers['cache-control'] = 'public, max-age=0, must-revalidate';
    headers['netlify-cdn-cache-control'] = `public, durable, s-maxage=${cache.sMaxAge}`
      + (cache.staleWhileRevalidate > 0 ? `, stale-while-revalidate=${cache.staleWhileRevalidate}` : '');
    if (cache.vary) headers['netlify-vary'] = cache.vary;
  } else {
    headers['cache-control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), {status, headers});
}

const failure = error => {
  const status = error instanceof GuestyUnavailable ? error.status : 'error';
  const code = status === 'not_configured' ? 503 : /^(token_backoff|token_busy|token_allowance|token_hold|rate_limited)$/.test(status) ? 503 : 502;
  return {status, code};
};

const CALENDAR_CACHE = {sMaxAge: 300, staleWhileRevalidate: 300};

/**
 * deps: {env, store, fetch, now, log, memo, stays, listings, timeoutMs}
 */
export async function calendarResponse(slug, deps) {
  const {stay, listingId, conflict} = resolveStay(slug, deps.stays, deps.listings);
  const from = today(deps.now());
  const to = addDays(from, CALENDAR_DAYS - 1);
  const log = status => deps.log(JSON.stringify({fn: 'calendar', listing: listingId, from, to, status}));
  if (!stay || !listingId) {
    log(conflict ? 'mapping_conflict' : stay ? 'unmapped' : 'unknown_stay');
    return respond(404, {ok: false}, null);
  }
  try {
    const guesty = createGuesty({clientId: deps.env.GUESTY_BE_CLIENT_ID, clientSecret: deps.env.GUESTY_BE_CLIENT_SECRET,
      store: deps.store, fetch: deps.fetch, now: deps.now, memo: deps.memo, timeoutMs: deps.timeoutMs});
    const body = await guesty.get(`/api/listings/${encodeURIComponent(listingId)}/calendar?from=${from}&to=${to}`);
    const days = mapCalendar(body, from, to);
    log('ok');
    return respond(200, {ok: true, from, to, days}, CALENDAR_CACHE);
  } catch (error) {
    const {status, code} = failure(error);
    log(status);
    return respond(code, {ok: false}, null);
  }
}

export async function quoteResponse(slug, params, deps) {
  const {stay, listingId, conflict} = resolveStay(slug, deps.stays, deps.listings);
  const checkIn = params.get('checkIn');
  const checkOut = params.get('checkOut');
  const guests = Number(params.get('guests'));
  const datesValid = isDate(checkIn) && isDate(checkOut);
  const log = status => deps.log(JSON.stringify({fn: 'quote', listing: listingId,
    checkIn: datesValid ? checkIn : null, checkOut: datesValid ? checkOut : null, status}));
  if (!stay || !listingId) {
    log(conflict ? 'mapping_conflict' : stay ? 'unmapped' : 'unknown_stay');
    return respond(404, {ok: false}, null);
  }
  const first = today(deps.now());
  const nights = datesValid ? daysBetween(checkIn, checkOut) : 0;
  // The whole stay, check-out included, must fall within the two years Guesty serves.
  if (!datesValid || checkIn < first || daysBetween(first, checkOut) > MAX_DAYS_AHEAD || nights < 1 || nights > MAX_NIGHTS
    || !Number.isInteger(guests) || guests < 1 || guests > stay.guests) {
    log('bad_request');
    return respond(400, {ok: false}, null);
  }
  try {
    const guesty = createGuesty({clientId: deps.env.GUESTY_BE_CLIENT_ID, clientSecret: deps.env.GUESTY_BE_CLIENT_SECRET,
      store: deps.store, fetch: deps.fetch, now: deps.now, memo: deps.memo, timeoutMs: deps.timeoutMs});
    const body = await guesty.post('/api/reservations/quotes', {
      listingId, checkInDateLocalized: checkIn, checkOutDateLocalized: checkOut, guestsCount: guests
    });
    const {expiresAt, ...quote} = mapQuote(body, {checkIn, checkOut});
    const lifetime = quoteLifetime(expiresAt, deps.now());
    if (!lifetime) throw new GuestyUnavailable('quote_expired');
    log('ok');
    return respond(200, {ok: true, checkIn, checkOut, nights, guests, ...quote, validFor: lifetime.validFor},
      {sMaxAge: lifetime.sMaxAge, staleWhileRevalidate: lifetime.staleWhileRevalidate, vary: 'query=checkIn|checkOut|guests'});
  } catch (error) {
    const {status, code} = failure(error);
    log(status);
    return respond(code, {ok: false}, null);
  }
}
