#!/usr/bin/env node
// Owner script: list the listings in the Guesty Booking Engine API instance (id + title) and
// suggest data/guesty-listings.json. Run it on your own machine:
//
//   node scripts/guesty-listings.mjs
//
// It reads GUESTY_BE_CLIENT_ID and GUESTY_BE_CLIENT_SECRET from the environment, or asks for them
// (the secret is not echoed). It prints nothing secret and writes no file.
//
// Each run requests one access token from the same small daily allowance the site uses (Guesty:
// "Tokens can only be renewed 3 times in 24 hours"), and the site cannot see that request. So after
// every run, whatever it printed and even if it failed or stopped, keep every stay in
// data/guesty-listings.json blank for the later of 24 hours and any stop Guesty sends (the script
// prints it; docs/GUESTY_SETUP.md, step 4). Never run it in a loop.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {API_BASE, TOKEN_URL} from '../netlify/lib/guesty.js';

const DAY = 24 * 3600e3;
const normalize = text => String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// A listing is suggested for a stay only when exactly one Guesty title contains the stay's name.
export function suggest(stays, listings) {
  const map = {};
  for (const stay of stays) {
    const name = normalize(stay.name);
    const hits = listings.filter(listing => normalize(listing.title).includes(name));
    map[stay.slug] = hits.length === 1 ? hits[0].id : '';
  }
  return map;
}

// GET /api/listings (getApplicationListingsList): `results` is required, limit is at most 100, and
// pagination.cursor.next is the cursor for the next page (null on the last); pagination.total is
// the number of listings. A reply without the results array, more pages than MAX_PAGES, or fewer
// listings than a total Guesty states is an error: never a short list that looks complete.
export const MAX_PAGES = 20;
const TIMEOUT_MS = 15000;

// An error this script words itself (it holds no secret), as opposed to one from fetch or the JSON
// parser, whose own text is never shown.
class OwnerStop extends Error {}

// Round 6, fix 2: a failure reported to Hank is always a fresh Error naming the operation and the
// one effective wait. A native timeout is a DOMException whose message is read-only, so it is never
// appended to; a foreign error is described by its kind, never by its own text.
function ownerError(operation, error, waitUntil, timeoutMs) {
  const cause = error instanceof OwnerStop ? error.message.replace(/\.$/, '')
    : error && error.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
    : error && error.name === 'SyntaxError' ? 'Guesty\'s reply could not be read'
    : 'the request failed before Guesty answered';
  return new Error(`${operation} failed: ${cause}. Keep every stay blank and do not run this script again before ${stamp(new Date(waitUntil))}, the wait printed above.`);
}

export async function listAllListings(fetchImpl, token, timeoutMs = TIMEOUT_MS) {
  const listings = new Map();
  let cursor = '';
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/api/listings', API_BASE);
    url.searchParams.set('fields', '_id title');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetchImpl(url, {headers: {authorization: 'Bearer ' + token, accept: 'application/json; charset=utf-8'}, signal: AbortSignal.timeout(timeoutMs)});
    if (!res.ok) throw new OwnerStop(`Listing request refused: HTTP ${res.status}.`);
    const body = await res.json();
    if (!body || !Array.isArray(body.results)) throw new OwnerStop('Guesty sent a listing page without its results list; nothing was printed. Run the script again later.');
    for (const item of body.results) {
      if (!item || typeof item._id !== 'string' || !item._id) throw new OwnerStop('Guesty sent a listing without an id; nothing was printed.');
      listings.set(item._id, {id: item._id, title: typeof item.title === 'string' ? item.title : ''});
    }
    const stated = body.pagination && body.pagination.total;
    if (Number.isInteger(stated) && stated >= 0) total = Math.max(total ?? 0, stated);
    cursor = body.pagination && body.pagination.cursor && body.pagination.cursor.next;
    if (!cursor) {
      if (total !== null && listings.size !== total) {
        throw new OwnerStop(`Guesty says the instance has ${total} listing(s) but sent ${listings.size}: the list is incomplete, so nothing was printed.`);
      }
      return [...listings.values()];
    }
  }
  throw new OwnerStop(`More than ${MAX_PAGES * 100} listings: the list is incomplete, so no map is suggested.`);
}

// The token request (Authentication page): POST, form-encoded grant_type, scope, client_id and
// client_secret. The wait is printed BEFORE the request is sent, so it holds for a run that fails,
// times out or is interrupted after Guesty may already have issued a token.
const stamp = date => `${date.toISOString()} (${date.toLocaleString('en-US', {timeZoneName: 'short'})})`;

// Guesty's own stop in a token reply, as a time, or null: a 429's Retry-After (seconds or an HTTP
// date), and, when no slot is left, ratelimit-reset (seconds until a used slot regenerates).
export function guestyStop(res, at) {
  const times = [];
  const retry = (res.headers.get('retry-after') || '').trim();
  if (res.status === 429 && /^\d+$/.test(retry)) times.push(at + Number(retry) * 1000);
  else if (res.status === 429 && Number.isFinite(Date.parse(retry))) times.push(Date.parse(retry));
  const remaining = (res.headers.get('ratelimit-remaining') || '').trim();
  const reset = (res.headers.get('ratelimit-reset') || '').trim();
  if (remaining === '0' && /^\d+$/.test(reset)) times.push(at + Number(reset) * 1000);
  return times.length ? Math.max(...times) : null;
}

export async function requestOwnerToken({fetch: fetchImpl, clientId, clientSecret, log, now = Date.now, timeoutMs = TIMEOUT_MS}) {
  const start = now();
  const until = start + DAY;
  log(`This run asks Guesty for one access token, from the same daily allowance the site uses.\n`
    + `Keep every stay in data/guesty-listings.json blank until ${stamp(new Date(until))}, 24 hours from now,\n`
    + `even if this run fails or stops. Do not run this script again before then.`);
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'client_credentials', scope: 'booking_engine:api', client_id: clientId, client_secret: clientSecret}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw ownerError('The token request', error, until, timeoutMs);
  }
  // Once Guesty's headers arrive, the wait is the later of the 24 hours and Guesty's own stop, and
  // a later stop is printed at once, before the body is read (round 6, fix 2).
  const stop = guestyStop(res, now());
  const later = stop !== null && stop > until
    ? `Guesty's own limit ends later: keep every stay blank until ${stamp(new Date(stop))}, and do not run this script again before then.`
    : '';
  const remaining = res.headers.get('ratelimit-remaining');
  if (res.ok && remaining) log(`Guesty reports ${remaining} token request(s) left in its 24-hour window. The 24-hour wait above applies whatever this number is.`);
  if (later) log(later);
  const waitUntil = later ? stop : until;
  if (!res.ok) {
    throw new Error(`Token request refused: HTTP ${res.status}${remaining ? `, token requests left today: ${remaining}` : ''}. `
      + (later || 'The 24-hour wait above still applies.'));
  }
  let body;
  try { body = await res.json(); } catch (error) { throw ownerError('Reading Guesty\'s token reply', error, waitUntil, timeoutMs); }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new Error('Guesty sent no access token. ' + (later || 'The 24-hour wait above still applies.'));
  // waitUntil: the one effective time, the later of the 24 hours and Guesty's stop.
  return {token: body.access_token, waitUntil};
}

function ask(question, hidden) {
  const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
  if (hidden) rl._writeToOutput = text => { if (text.startsWith(question)) process.stdout.write(question); };
  return new Promise(resolve => rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); }));
}

export async function run({env = process.env, fetch: fetchImpl = fetch, log = console.log, now = Date.now, prompt = ask, stays, timeoutMs = TIMEOUT_MS} = {}) {
  const clientId = env.GUESTY_BE_CLIENT_ID || await prompt('Guesty BE client ID: ');
  const clientSecret = env.GUESTY_BE_CLIENT_SECRET || await prompt('Guesty BE client secret (hidden): ', true);
  if (!clientId || !clientSecret) throw new Error('Both the client ID and the client secret are needed.');

  const {token, waitUntil} = await requestOwnerToken({fetch: fetchImpl, clientId, clientSecret, log, now, timeoutMs});
  // Round 5, fix 1, and round 6, fix 2: an incomplete, failed or timed-out list ends in a fresh error
  // that still names the one effective wait for the retry.
  let listings;
  try { listings = await listAllListings(fetchImpl, token, timeoutMs); } catch (error) {
    throw ownerError('The listing request', error, waitUntil, timeoutMs);
  }

  log(`\n${listings.length} listing(s) in this Booking Engine API instance:\n`);
  for (const listing of listings) log(`  ${listing.id}  ${listing.title}`);

  const list = stays || JSON.parse(await readFile(new URL('../data/stays.json', import.meta.url), 'utf8'));
  const map = suggest(list, listings);
  log('\nSuggested data/guesty-listings.json (a stay is filled only when exactly one title contains its name;');
  log('check every line against the list above and fill any blank by hand;');
  log(`put it in data/guesty-listings.json and push it only after ${stamp(new Date(waitUntil))}, the wait printed above):\n`);
  log(JSON.stringify(map, null, 2));
  const missing = list.filter(stay => !map[stay.slug]).map(stay => stay.name);
  if (missing.length) log(`\nNot matched: ${missing.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
