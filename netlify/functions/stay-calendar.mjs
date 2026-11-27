// GET /api/stays/:slug/calendar: open and blocked nights from Guesty for the next 365 days.
import {getStore} from '@netlify/blobs';
import stays from '../../data/stays.json' with {type: 'json'};
import listings from '../../data/guesty-listings.json' with {type: 'json'};
import {calendarResponse} from '../lib/stay-api.js';

const memo = {};
// A missing Blobs environment becomes a logged store_error and the Airbnb fallback, never a crash.
const tokenStore = () => { try { return getStore({name: 'guesty', consistency: 'strong'}); } catch { return null; } };

export default async (req, context) => {
  if (req.method !== 'GET') return new Response(null, {status: 405, headers: {allow: 'GET'}});
  return calendarResponse(context.params.slug, {
    env: process.env, store: tokenStore(), fetch,
    now: Date.now, log: console.log, memo, stays, listings
  });
};

export const config = {path: '/api/stays/:slug/calendar'};
