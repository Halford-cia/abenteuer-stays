# Stay Eden

Static guest site for ten vacation rentals near Fredericksburg, Texas.

With Node 22+ and Python 3, run `npm run build`, then `npm run preview` and open http://127.0.0.1:4173. Run `npm run check` before opening a pull request. The static preview does not run the Netlify Functions, so stay pages show the Airbnb handoff locally.

Live availability and quotes come from the Guesty Booking Engine API through two Netlify Functions (`/api/stays/:slug/calendar`, `/api/stays/:slug/quote`). To map stays to Guesty listings, follow [docs/GUESTY_SETUP.md](docs/GUESTY_SETUP.md): run `node scripts/guesty-listings.mjs` once on your own machine, then keep every stay blank for 24 hours before filling `data/guesty-listings.json`.

See [CLAUDE.md](CLAUDE.md) for content, booking and Netlify conventions.
