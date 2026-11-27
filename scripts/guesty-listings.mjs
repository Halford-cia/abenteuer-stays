#!/usr/bin/env node
// Owner script: list the listings in the Guesty Booking Engine API instance (id + title) and
// suggest data/guesty-listings.json. Run it on your own machine:
//
//   node scripts/guesty-listings.mjs
//
// It reads GUESTY_BE_CLIENT_ID and GUESTY_BE_CLIENT_SECRET from the environment, or asks for them
// (the secret is not echoed). It prints nothing secret and writes no file.
// Each run requests one access token: Guesty allows only a few a day per instance, shared with the
// site, so run it once, not in a loop.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {API_BASE, TOKEN_URL} from '../netlify/lib/guesty.js';

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

function ask(question, hidden) {
  const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
  if (hidden) rl._writeToOutput = text => { if (text.startsWith(question)) process.stdout.write(question); };
  return new Promise(resolve => rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); }));
}

async function main() {
  const clientId = process.env.GUESTY_BE_CLIENT_ID || await ask('Guesty BE client ID: ');
  const clientSecret = process.env.GUESTY_BE_CLIENT_SECRET || await ask('Guesty BE client secret (hidden): ', true);
  if (!clientId || !clientSecret) throw new Error('Both the client ID and the client secret are needed.');

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'client_credentials', scope: 'booking_engine:api', client_id: clientId, client_secret: clientSecret}),
    signal: AbortSignal.timeout(15000)
  });
  const remaining = tokenRes.headers.get('ratelimit-remaining');
  if (!tokenRes.ok) throw new Error(`Token request refused: HTTP ${tokenRes.status}${remaining ? `, token requests left today: ${remaining}` : ''}.`);
  const {access_token: token} = await tokenRes.json();
  if (remaining) console.log(`Token requests left in Guesty's 24-hour window: ${remaining}`);

  const listings = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL('/api/listings', API_BASE);
    url.searchParams.set('fields', '_id title');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {headers: {authorization: 'Bearer ' + token, accept: 'application/json; charset=utf-8'}, signal: AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error(`Listing request refused: HTTP ${res.status}.`);
    const body = await res.json();
    for (const item of body.results || []) listings.push({id: item._id, title: item.title || ''});
    cursor = body.pagination && body.pagination.cursor && body.pagination.cursor.next;
    if (!cursor) break;
  }

  console.log(`\n${listings.length} listing(s) in this Booking Engine API instance:\n`);
  for (const listing of listings) console.log(`  ${listing.id}  ${listing.title}`);

  const stays = JSON.parse(await readFile(new URL('../data/stays.json', import.meta.url), 'utf8'));
  const map = suggest(stays, listings);
  console.log('\nSuggested data/guesty-listings.json (a stay is filled only when exactly one title contains its name;');
  console.log('check every line against the list above and fill any blank by hand):\n');
  console.log(JSON.stringify(map, null, 2));
  const missing = stays.filter(stay => !map[stay.slug]).map(stay => stay.name);
  if (missing.length) console.log(`\nNot matched: ${missing.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
