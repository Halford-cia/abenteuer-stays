# Guesty setup (phase A): the procedure of record

This file is the only setup procedure for Guesty live availability and quotes. It replaces the steps in the PR #3 description and in earlier reports. Phase A is read-only: the site shows Guesty's blocked dates, minimum nights and quote, and the Book button still hands off to Airbnb. The site creates no reservation and takes no payment.

Two facts drive the order of the steps:

- **Guesty allows very few tokens.** The Authentication page says "Tokens can only be renewed 3 times in 24 hours". Its header quota (`ratelimit-limit`) and the quick start give 5. The site uses the lower figure. Every token request counts, including one whose reply never arrives.
- **The owner script's token is invisible to the site.** The script runs on your Mac. The site's record of token requests is in Netlify, so the site cannot count the script's request. The only safe rule is to keep every stay unmapped for 24 hours after any run of the script, or until Guesty's own stop when it ends later (step 4), including a run that fails or stops.

## 1. Check the Netlify plan

- Choosing a scope for each variable requires Netlify Pro or Enterprise. Netlify's default is **all scopes**, which includes Builds.
- If the site's plan cannot limit a variable to **Functions**, stop and tell Claude before you enter any credential. With the Builds scope, anything that runs during the build could read the client secret, and with it the sealed token.

## 2. Check Guesty

1. Open the Booking Engine API instance. Guesty gives two menu paths, so use whichever your dashboard shows:
   - Help Center (current): **Marketing and sales → Channel management → Distribution → Guesty Booking Engine API**, then the instance's menu → **Edit API key**. This path comes from the round-3 review of PR #3. The Help Center article ([Creating and editing a Guesty Booking Engine API instance](https://help.guesty.com/hc/en-gb/articles/18132541671069-Creating-and-editing-a-Guesty-Booking-Engine-API-instance)) refuses automated readers (HTTP 403), so it could not be checked again here.
   - Developer Authentication page (older): top menu **Growth → Distribution → Booking Engine API**.
2. Confirm that **all ten** Stay Eden properties are assigned to this instance.
3. Confirm that both booking sources are activated. Guesty's quote reference requires this before the reservation endpoints are used, and the sources carry your fees and taxes:
   - The **Manual** source is activated by one manual reservation in the Guesty UI. If your account already has direct reservations, you can skip this.
   - The **BE API** source is activated by a first reservation made through the Booking Engine API. It is what lets you set up additional fees, taxes, auto payments and messages for this channel.
   - The site cannot make either reservation (phase A creates none). If the BE API source is not active, you and Guesty make that first reservation outside this site. Until then, quotes may lack the BE API fees and taxes.

## 3. Add the two variables in Netlify

Go to Site configuration → Environment variables. Add both `GUESTY_BE_CLIENT_ID` and `GUESTY_BE_CLIENT_SECRET`, and for each one:

- Tick **Contains secret values**.
- Under **Scopes**, choose **Functions only**. Untick Builds, Runtime and Post processing.
- Under deploy contexts, choose different values per context. Enter the value explicitly for **Production** and for **Deploy Previews**. Leave Branch deploys, Preview server and Local development empty.
- Redeploy afterwards. Functions pick up variable changes only on a new deploy.

## 4. Run the listing script once, then wait (24 hours, or Guesty's later stop)

```
cd ~/str/guesty && git pull && node scripts/guesty-listings.mjs
```

- Before the request is sent, the script prints a time 24 hours ahead. **Keep every stay in `data/guesty-listings.json` blank until at least that time.** This holds whatever the script prints next, including a report of 4 or 5 tokens left, an error, a timeout or a stop with Ctrl-C.
- If Guesty answers with its own stop that ends later (a 429's `Retry-After`, or no slot left and a `ratelimit-reset` beyond 24 hours), the script prints that later time too. **Wait for the later of the two times**, both before mapping any stay and before running the script again. The line above the suggested map repeats the time that applies.
- Do not run the script again before that time. A second run starts a new 24-hour wait.
- The script prints nothing if the listing list is incomplete: a missing results list, a listing without an id, fewer listings than Guesty's stated total, or more pages than it reads. In that case, wait the 24 hours and run it once more. Never run it in a loop.
- It writes no file. Copy the suggested map, and check each line against the printed list.

## 5. Map nine stays and keep one blank

- After the wait, fill **nine** of the ten stays in `data/guesty-listings.json` and leave one blank on purpose. The blank stay is the fallback check in step 6.
- Each Guesty listing id may appear **once**. If one id is entered for two stays, `npm run check` fails, and neither stay shows live data (status `mapping_conflict`) until the map is corrected.
- Run `npm run check`; it must pass with the map filled. Then commit and push to `feat/guesty`.
- The first page view on a mapped stay requests the site's first token. The site never requests more than its allowance.

## 6. Smoke on the Deploy Preview

On a **mapped** stay:

- Booked nights are struck through, and the minimum stay shows when you choose a check-in.
- For valid dates, Guesty's nightly prices, invoice lines and total appear. A tax that Guesty reports as included in a line is named beside that line and not added again.
- **Compare the total with Guesty.** In the Guesty dashboard, quote the **same listing, dates, number of adults, rate plan, currency and BE API source** as the preview. The two totals must match exactly. If several rate plans exist, the page names the plan it shows.
- Book still opens Airbnb with your dates and adults.

On the **blank** stay: the page looks exactly as it does today, with no live panel and no request to `/api/stays/`.

In Netlify → Logs → Functions, a working call logs `status:"ok"`. The other statuses mean:

| Status | Meaning |
| --- | --- |
| `not_configured` | A variable is missing, or it is not scoped to Functions. |
| `token_401` | Wrong credentials. See step 8. |
| `token_allowance` | The token allowance is spent. It frees itself 24 hours after the oldest request. |
| `token_hold` | The site could not record Guesty's answer to a token request, so it asks for no token until 24 hours after that request. It frees itself. |
| `token_backoff` | A token request failed recently, so the site waits before the next one: Guesty's whole `Retry-After` after a 429, otherwise a short backoff. It frees itself. |
| `mapping_conflict` | One Guesty listing id is mapped to two stays. Correct `data/guesty-listings.json`. |
| `rate_limited` / `upstream_429` | Guesty asked the site to slow down. Every instance waits the whole Retry-After. |
| `quote_total_mismatch` / `quote_currency_mismatch` / `quote_malformed` / `quote_ambiguous` / `calendar_malformed` | Guesty's reply could not be shown exactly, so the page shows the Airbnb handoff alone. Send Claude the log line. |
| `quote_expired` | Guesty's quote expired before it could be shown. |

## 7. Map the tenth stay

Once step 6 passes on both kinds of page, fill the tenth stay, run `npm run check`, and push. No token is involved, because the site reuses its token for 24 hours.

## 8. After a credential change

1. Correct the variable in Netlify (step 3 settings) and **redeploy**.
2. Let the shared cooldown expire: 1 hour after a `token_401`, doubling after each further one, up to 24 hours. A `token_hold` or `token_allowance` also frees itself.
3. **Never delete** the `token-lease` or `token-issuance` entries in the `guesty` Blobs store. They hold the token count and the cooldown. Deleting them can spend tokens and lock the site out for the day.
4. Do not run the listing script to test new credentials. If you do, the 24-hour wait in step 4 applies again.

## 9. Lighthouse and merge

- Run Lighthouse (mobile) on a mapped stay in the preview and compare it with PR #2's preview.
- Merge PR #2 first, then PR #3. Every merge is yours.

## Still open (your decisions, not made here)

- **Price display.** The page shows Guesty's direct-booking total, but Book hands off to Airbnb, whose total can differ. One line on the page says so. Keep showing the price until phase B, or hide it?
- **Rate plan.** With several plans, the page shows the lowest guest charge and names its plan. It refuses to show an unnamed cheapest plan among several. Which plan to prefer is your call.
