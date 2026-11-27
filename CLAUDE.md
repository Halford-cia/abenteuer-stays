# Stay Eden

Stay Eden is the guest-facing site for ten Hill Country rentals near Fredericksburg, Texas. Abenteuer Management (Alford & Pruitt Investments LLC) operates the stays. Hank owns launch and merge decisions.

## Stack and commands

Node 22 or later builds plain HTML from src/ and data/ into dist/. Each route works as a static document. CSS, browser JavaScript, fonts and optimized property photos live in public/. The build has no package dependencies; the Netlify Functions in netlify/ use one, `@netlify/blobs` (pinned exact).

- `npm run build` generates the site.
- `npm run preview` serves the existing build at http://127.0.0.1:4173 using Python 3.
- `npm run check` builds and runs the site checks.

## Editing

- Keep unit facts, amenities and review snapshots in data/. Verify changes with the host or the corresponding public listing. Use aggregate counts only. Never commit or collect guest PII, booking records, private messages, credentials or secrets.
- Refresh the dated host and unit review snapshots together when preparing a release. Compare each listing’s pet rule and guest capacity with the unit facts and confirm any discrepancy with Hank.
- Keep booking-provider URLs and calls to action in src/booking.js. The Book button hands off to Airbnb.
- Guesty (Hank 2026-11-26): Stay Eden is managed in Guesty; direct booking goes through the Guesty Booking Engine API. Phase A is read only: live blocked dates, minimum nights and Guesty's quote on each stay page. No payment, card fields or reservation creation on the site.
  - Guesty is called only from netlify/functions (lib in netlify/lib), with GUESTY_BE_CLIENT_ID and GUESTY_BE_CLIENT_SECRET from Netlify environment variables. The browser never sees a credential or a guesty.com URL (test/live-booking.test.js guards it).
  - Tokens last 24 hours and Guesty allows only a few a day. netlify/lib/guesty.js keeps one token in the site-wide Blobs store `guesty`, sealed with AES-256-GCM under a key derived from GUESTY_BE_CLIENT_SECRET, because build plugins can read every store on the site: never store the token in the clear. Every token request is counted in `token-issuance` before it is sent (3 per rolling 24 hours, lowered by Guesty's `ratelimit-remaining`), and the owner script's token counts against the same allowance. Renewals are leased and back off on failure. Never request a token per request, and never delete the `token-lease` or `token-issuance` entries to force a renewal.
  - A Guesty 429 pauses every instance for the whole Retry-After; a shorter pause never replaces a longer one.
  - data/guesty-listings.json maps each stay slug to its Guesty listing id; `node scripts/guesty-listings.mjs` lists the instance's listings. An unmapped stay builds exactly as before, and any Guesty failure leaves the Airbnb handoff with no message to guests.
  - Show only amounts Guesty returns. The total is the rate plan's `money.hostPayout` (Guesty: the amount the guest is charged) in `money.currency`; its invoice lines must add up to it exactly at the currency's precision, or the quote is refused, never patched. An unreadable plan, or plans in different currencies, refuse the whole quote. A calendar day with a missing or unknown status refuses the whole calendar (no dates shown as taken). Log only the listing id, the dates and a status; never log guest details, tokens or response bodies.
- Update the site and its structured data from the same facts. Use the actual unit's photos, descriptive alt text, reserved image dimensions and responsive image sizes. Give replacement photos and social images new filenames so guests receive the updated image under the one-year immutable cache. Respect reduced motion.
- Build and check on a feature branch. Open a PR against main. Every merge is Hank's.

## Deploy

Netlify builds main using netlify.toml and exposes PRs as Deploy Previews once the repository is connected. Only production builds with an explicit HTTPS SITE_URL allow indexing. With SITE_URL unset, the build emits a robots meta tag on every page and a site-wide X-Robots-Tag header in dist/_headers. Previews do the same even when SITE_URL is present. Keep SITE_URL unset until Hank confirms listing pet rules, The Hidden Tavern’s overnight limit and the amenity list, then set it to the chosen custom origin. After deployment, check the live homepage and a stay page for the expected canonical, robots meta tag and HTTP header. The 404 always requests no indexing. For iOS and Android sign-off, share the deploy-specific permalink from the current PR build (`https://<deploy-id>--stayeden.netlify.app/`). The PR alias adds a review drawer that can intercept taps at the bottom of the screen. Local builds use localhost.
