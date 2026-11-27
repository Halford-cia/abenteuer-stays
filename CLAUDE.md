# Stay Eden

Stay Eden is the guest-facing site for ten Hill Country rentals near Fredericksburg, Texas. Abenteuer Management (Alford & Pruitt Investments LLC) operates the stays. Hank owns launch and merge decisions.

## Stack and commands

Node 22 or later builds plain HTML from src/ and data/ into dist/. Each route works as a static document. CSS, browser JavaScript, fonts and optimized property photos live in public/. The build has no package dependencies.

- `npm run build` generates the site.
- `npm run preview` serves the existing build at http://127.0.0.1:4173 using Python 3.
- `npm run check` builds and runs the site checks.

## Editing

- Keep unit facts, amenities and review snapshots in data/. Verify changes with the host or the corresponding public listing. Use aggregate counts only. Never commit or collect guest PII, booking records, private messages, credentials or secrets.
- Refresh the dated host and unit review snapshots together when preparing a release. Compare each listing’s pet rule and guest capacity with the unit facts and confirm any discrepancy with Hank.
- Keep booking-provider URLs and calls to action in src/booking.js. The v1 provider is Airbnb. Hank will select the direct-booking engine.
- Update the site and its structured data from the same facts. Use the actual unit's photos, descriptive alt text, reserved image dimensions and responsive image sizes. Give replacement photos and social images new filenames so guests receive the updated image under the one-year immutable cache. Respect reduced motion.
- Build and check on a feature branch. Open a PR against main. Every merge is Hank's.

## Deploy

Netlify builds main using netlify.toml and exposes PRs as Deploy Previews once the repository is connected. Only production builds with an explicit HTTPS SITE_URL allow indexing. Builds on Netlify’s fallback URL and all previews request no indexing. Set SITE_URL to the chosen custom origin after Hank confirms listing pet rules, The Hidden Tavern’s overnight limit and the amenity list. Review the connected PR preview on iOS and Android before launch. Local builds use localhost.
