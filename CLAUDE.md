# Ledger App — Technical Architecture & Handoff Summary

## What this app does
A personal subscription-tracking tool: connects to a real bank account via Plaid,
detects recurring charges from transaction history, flags ones that look idle,
and (behind a $15/mo paywall) walks the user through manually canceling them.
Built for $0 budget, deployed on free-tier infrastructure, intended for personal/
family testing rather than public launch.

## Tech stack
- **Backend**: Node.js + Express, single `server.js` file
- **Frontend**: Single static `index.html` (vanilla JS, no framework), served
  directly by Express from the same directory as `server.js`
- **Bank data**: Plaid API (currently Sandbox mode — fake banks/data)
- **Payments**: Stripe Checkout (Test mode) + Stripe webhooks
- **Hosting**: Render.com free tier (web service, auto-deploys from GitHub)
- **Source control**: GitHub (public repo), manual file edits via GitHub web UI
  (no local dev environment — user is on a Chromebook with no Linux/devtools)
- **Storage**: None — all state (Plaid access tokens, Stripe subscription
  status) is kept in plain in-memory JS objects (`accessTokens`,
  `paidSubscribers`) and is wiped every time the server restarts/redeploys

## Features built so far

### 1. Plaid bank connection
- `/api/create_link_token` — creates a Plaid Link token
- `/api/exchange_public_token` — exchanges public token for permanent access
  token, stored in-memory keyed by `userId` (currently hardcoded to
  `'default_user'` everywhere — no real multi-user support)
- Frontend uses Plaid's hosted Link widget (`cdn.plaid.com/link/v2/stable/link-initialize.js`)

### 2. Transaction fetching + subscription detection (DIY, not Plaid's built-in endpoint)
- Originally planned to use Plaid's `/transactions/recurring/get`, but that
  requires a separate product-access request/approval from Plaid, so it was
  abandoned in favor of building detection manually
- `/api/transactions/:userId` pulls raw transactions via `transactionsSync`
  (paginated), then runs custom grouping logic (`detectRecurringCharges`):
  - Groups transactions by `merchant_name`
  - Requires ≥2 charges from the same merchant
  - Requires charge amounts within 10% of each other
  - Estimates frequency (WEEKLY/BIWEEKLY/MONTHLY/QUARTERLY/ANNUAL) from
    average gap between charge dates
  - Flags `isIdle: true` if days-since-last-charge exceeds avgGapDays + 30
- **Known timing issue (solved)**: right after a fresh Plaid Link connection,
  Sandbox transaction data isn't immediately available. Fixed with a retry
  loop (`fetchAllTransactions` retried up to 4x with 2s delays) in the
  transactions route.
- **Current temporary hack**: `FORCE_IDLE_FOR_TESTING` env var forces the
  first detected subscription to show as idle, since real Sandbox test data
  (via `user_transactions_dynamic` test user) didn't reliably produce idle
  results. **This needs to be removed** once real idle-detection testing is
  no longer needed — it's a deliberate cheat for QA purposes only.

### 3. Cancel flow (frontend)
- Idle subscriptions get a "Cancel" button
- Clicking it checks `isSubscribed` (from Stripe status) — if false, shows
  paywall modal instead
- If subscribed, opens a modal with merchant-specific step-by-step
  cancellation instructions (`CANCEL_GUIDES` object — hardcoded guides for
  Netflix, Spotify, OpenAI, Planet Fitness, Amazon Prime, Audible; generic
  fallback text for anything else)
- "Mark as canceled" just updates the UI client-side (greys out card, shows
  toast with estimated annual savings) — **does not persist anywhere**, resets
  on page reload
- No real automated cancellation exists or is planned — no universal API for
  this exists; this was a deliberate, disclosed limitation from the start

### 4. Stripe paywall ($15/mo)
- `/api/create_checkout_session` — creates a Stripe Checkout Session
  (`mode: 'subscription'`, $15/mo price built inline via `price_data`, not a
  pre-created Stripe Product/Price)
- Redirects to Stripe-hosted checkout page (test card `4242 4242 4242 4242`
  works in Test mode)
- `/api/stripe-webhook` — listens for `checkout.session.completed` and
  `customer.subscription.deleted`, updates `paidSubscribers[userId]`
- `/api/subscription-status/:userId` — frontend polls this to decide whether
  to show paywall or real cancel flow
- Frontend also has `handlePostCheckoutReturn()` — on returning from Stripe
  with `?subscribed=true` in the URL, optimistically shows a toast and
  polls subscription-status a few times with delay, since webhook delivery
  isn't instant

## Key architectural decisions / why
- **No database** — deliberate, to keep this $0 and simple for a first
  working version. Major limitation: all state (who's connected, who's paid)
  is wiped on every server restart, which happens on every redeploy and
  periodically on Render's free tier (sleep/wake cycles). This is the single
  biggest thing to fix before this could be a real multi-user product.
- **Single-file frontend, single-file backend** — no build step, no bundler,
  chosen specifically because the user has no local dev environment
  (Chromebook, no Linux, no terminal, no dev tools) and all edits were done
  by pasting full-file contents into GitHub's web editor.
- **`userId` is hardcoded to `'default_user'`** everywhere in both frontend
  and backend — there is no real auth or multi-user separation. Fine for one
  person testing, not fine for anything beyond that.
- **Plaid Sandbox only so far** — never moved to Development/Production
  (real bank data), despite that being part of the original plan. Plaid
  gives ~200 free production API calls, which was the intended path for
  testing with the user's/family's real accounts, but wasn't reached yet.
- **Stripe Test mode only** — never moved to live payments. Real billing
  would require Stripe account activation with real bank details.

## Known bugs fixed during development (useful debugging history)
1. **Render serves from a `src` subdirectory in some configs** — static file
   path had to be made resilient/absolute (`__dirname`-based), and the
   `public/` subfolder was ultimately abandoned in favor of keeping
   `index.html` directly next to `server.js`, because GitHub's web upload
   flow kept creating duplicate/misnamed files when used repeatedly.
2. **Plaid Sandbox needs a few seconds after Link success before
   `transactionsSync` returns real data** — fixed with retry/backoff logic.
3. **Stripe webhook signature verification was failing 100% of the time** —
   root cause: `app.use(express.json())` was global and ran before the
   webhook route, so by the time `express.raw()` tried to grab the raw body
   for signature verification, the body had already been consumed/parsed by
   the global JSON middleware. Fixed by moving the webhook route definition
   (with its own `express.raw()` middleware) to *before* the global
   `express.json()` call in the file.

## CURRENT UNRESOLVED BUG (where we left off)
After fixing the webhook signature issue, **Stripe webhook deliveries now
show as successful (200/green) in Stripe's dashboard**, but:
- `console.log('Payment confirmed for user: ...')` does NOT appear in Render
  logs for that successful delivery
- `/api/subscription-status/default_user` still returns `{"isSubscribed":false}`
  after a completed test checkout

This means the webhook handler is returning a 200 (so something inside it is
executing without throwing), but the `if (event.type === 'checkout.session.completed')`
branch is apparently not running, or `paidSubscribers[userId] = true` isn't
sticking. Leading hypotheses not yet confirmed:
- The successful webhook delivery might be an **automatic Stripe retry of an
  older/different event** rather than the most recent test checkout — needs
  timestamp comparison (was mid-investigation when this summary was
  requested).
- Possible mismatch between `userId` used when creating the checkout session
  (`client_reference_id`) and what's read back out in the webhook handler.
- Render's free-tier logs could theoretically be dropping/delaying log lines,
  though this is less likely given the 200 response.
- Worth adding temporary verbose logging at the very top of the webhook
  handler (log `event.type` unconditionally, before the if-checks) to see
  definitively what event type/payload is actually arriving on the
  "successful" delivery.

## Next implementation steps (in rough priority order)
1. **Debug and fix the subscription-status bug above** — add unconditional
   logging of `event.type` and `event.data.object` at the top of the webhook
   handler, redeploy, trigger a fresh test checkout, inspect logs directly
   against the Stripe dashboard event ID to confirm they're the same event.
2. **Remove `FORCE_IDLE_FOR_TESTING` hack** once subscription flow is
   confirmed working, and once idle-detection has been separately validated
   against real data.
3. **Add a real database** (even something lightweight like SQLite or a
   free-tier Postgres) to persist `accessTokens` and `paidSubscribers` across
   restarts — this is the biggest structural gap before this is usable
   beyond a single testing session.
4. **Real multi-user support** — replace hardcoded `'default_user'` with
   actual auth (even something simple like a login email) so this could
   eventually serve more than one person.
5. **Move Plaid to Development/Production** to test with real bank accounts
   (~200 free API calls available) — not yet attempted.
6. **Decide on Stripe Product/Price setup** — currently creates an inline
   ad-hoc price on every checkout session; for a real launch this should be
   a proper Stripe Product/Price configured once in the dashboard.
7. **Persist "canceled" state server-side** — currently purely cosmetic/
   client-side and lost on refresh.
8. **Eventually move off Render free tier** if real usage is expected — free
   tier sleep/wake cycles already caused confusion during testing (cold
   starts, webhook timeout suspicion) even though they weren't the actual
   bug in the end.
