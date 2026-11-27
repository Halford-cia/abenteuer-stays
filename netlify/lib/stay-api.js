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

export function mapCalendar(body, from, to) {
  if (!Array.isArray(body)) throw new GuestyUnavailable('calendar_malformed');
  const seen = new Map();
  for (const entry of body) {
    if (!entry || !isDate(entry.date) || entry.date < from || entry.date > to) continue;
    const minNights = Number.isInteger(entry.minNights) && entry.minNights > 0 ? entry.minNights : 1;
    seen.set(entry.date, {
      date: entry.date,
      available: entry.status === 'available',
      minNights,
      noArrival: entry.cta === true,
      noDeparture: entry.ctd === true
    });
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

const money = value => typeof value === 'number' && Number.isFinite(value);
const cents = value => Math.round(value * 100);

// One rate plan's invoice: Guesty's own line titles and amounts, in Guesty's order.
function planInvoice(plan) {
  const detail = plan && (plan.money || (plan.ratePlan && plan.ratePlan.money));
  const items = detail && detail.invoiceItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  const currency = items[0] && items[0].currency || detail.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  const lines = [];
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || !money(item.amount)) return null;
    if ((item.currency || currency) !== currency) return null;
    lines.push({title: item.title.trim().slice(0, 80), amount: cents(item.amount) / 100});
  }
  const total = lines.reduce((sum, line) => sum + cents(line.amount), 0);
  // The invoice must agree with Guesty's own subtotal and taxes when Guesty returns them.
  if (money(detail.subTotalPrice) && money(detail.totalTaxes) && Math.abs(cents(detail.subTotalPrice) + cents(detail.totalTaxes) - total) > 1) {
    throw new GuestyUnavailable('quote_total_mismatch');
  }
  const name = plan.ratePlan && typeof plan.ratePlan.name === 'string' ? plan.ratePlan.name.trim().slice(0, 80) : '';
  return {currency, lines, total: total / 100, ratePlan: name};
}

export function mapQuote(body) {
  const plans = body && body.rates && Array.isArray(body.rates.ratePlans) ? body.rates.ratePlans : null;
  if (!plans || plans.length === 0) throw new GuestyUnavailable('quote_malformed');
  const invoices = plans.map(planInvoice).filter(Boolean);
  if (invoices.length === 0) throw new GuestyUnavailable('quote_malformed');
  // Several rate plans: show the lowest total Guesty offers for these dates.
  invoices.sort((a, b) => a.total - b.total);
  const best = invoices[0];
  return {...best, ratePlan: invoices.length > 1 ? best.ratePlan : ''};
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
  const code = status === 'not_configured' ? 503 : /^(token_backoff|token_busy|rate_limited)$/.test(status) ? 503 : 502;
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
  if (!datesValid || checkIn < first || daysBetween(first, checkIn) > MAX_DAYS_AHEAD || nights < 1 || nights > MAX_NIGHTS
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
