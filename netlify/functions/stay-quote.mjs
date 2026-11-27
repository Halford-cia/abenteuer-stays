// GET /api/stays/:slug/quote?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N: Guesty's price for those dates.
// Read only: a Guesty quote is not a reservation and no guest details are sent.
import {getStore} from '@netlify/blobs';
import stays from '../../data/stays.json' with {type: 'json'};
import listings from '../../data/guesty-listings.json' with {type: 'json'};
import {quoteResponse} from '../lib/stay-api.js';

const memo = {};
// A missing Blobs environment becomes a logged store_error and the Airbnb fallback, never a crash.
const tokenStore = () => { try { return getStore({name: 'guesty', consistency: 'strong'}); } catch { return null; } };

export default async (req, context) => {
  if (req.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET'}});
  return quoteResponse(context.params.slug, new URL(req.url).searchParams, {
    env: process.env, store: tokenStore(), fetch,
    now: Date.now, log: console.log, memo, stays, listings
  });
};

export const config = {path: '/api/stays/:slug/quote'};
