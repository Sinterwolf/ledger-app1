# Ledger — Setup Guide (No Coding Required)

This guide walks you through getting this app live with **real Plaid bank
data**, for **$0**, using only your web browser. No installs needed.

---

## What you're about to do (in plain English)

1. Get free Plaid API keys (your "permission" to talk to Plaid)
2. Put this code on GitHub (a free place to store code online)
3. Connect GitHub to Render (a free place to *run* the code, 24/7)
4. Tell Render your secret Plaid keys (without ever putting them in the code itself)
5. Visit your new live website and connect a real bank account

---

## Step 1 — Get your Plaid API keys

1. Go to **dashboard.plaid.com/signup** and create a free account.
2. Once logged in, go to **Team Settings → Keys** in the left sidebar.
3. You'll see a **client_id** and a **Sandbox secret**. Copy both somewhere safe —
   you'll paste them into Render in Step 4.
4. Leave everything else as default for now — we're starting in **Sandbox**
   mode (fake banks, fake data, unlimited and free) to prove everything works
   before touching real accounts.

---

## Step 2 — Put the code on GitHub

1. Go to **github.com** and create a free account if you don't have one.
2. Click the **+** icon (top right) → **New repository**.
3. Name it `ledger-app`, keep it **Public**, click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag in every file from this project folder (server.js, package.json,
   .gitignore, the `public` folder with index.html inside it, etc.)
   — **except** `.env.example` doesn't need special handling, just upload it
   too, it has no real secrets in it.
6. Scroll down, click **Commit changes**.

Your code is now on GitHub. You won't need to touch GitHub again unless you
want to update the code later.

---

## Step 3 — Deploy it on Render

1. Go to **render.com** and sign up free (no credit card needed).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account when prompted, then select the `ledger-app`
   repository you just created.
4. Render will auto-detect it's a Node.js app. Leave the defaults:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Choose the **Free** instance type.
6. Before clicking "Create Web Service," scroll to **Environment Variables**
   and add these (this is how your secret keys get to the server *without*
   ever being written in the code or uploaded to GitHub):

   | Key | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | (paste your client_id from Step 1) |
   | `PLAID_SECRET` | (paste your Sandbox secret from Step 1) |
   | `PLAID_ENV` | `sandbox` |

7. Click **Create Web Service**. Render will build and deploy — this takes
   a few minutes the first time. Watch the logs; when you see
   `Ledger server running on port ...`, it's live.
8. Render gives you a free URL like `https://ledger-app-xxxx.onrender.com`
   — that's your real, live website.

**Note:** Free Render services "fall asleep" after 15 minutes of no use, and
take about 30-60 seconds to wake back up on the next visit. Totally normal,
not a bug.

---

## Step 4 — Try it out (Sandbox mode first)

1. Visit your Render URL.
2. Click **Connect your bank**.
3. In the Plaid popup, search for **"First Platypus Bank"** — a fake test
   bank Plaid provides for Sandbox use.
4. Use Plaid's official test login: username `user_transactions_dynamic`,
   password — anything at all (Sandbox accepts any password for test
   users). This particular test username is documented by Plaid as coming
   pre-loaded with six months of realistic recurring transactions, which
   is what lets you actually see the subscription detection do something
   interesting, rather than an empty result.
5. You should land on the results page with fake recurring subscriptions
   flagged as idle or active.

If that works end-to-end, the entire pipeline (server, Plaid connection,
transaction detection, results page) is proven to work.

---

## Step 5 — Switch to REAL bank data (you + your dad only)

1. Back in your Plaid dashboard, find the **Limited Production** /
   **Development** secret (separate from your Sandbox secret, same Keys page).
2. You may need to click a button like "Add Production Access" — Plaid will
   ask a couple of questions about your use case. Personal/non-commercial
   use is fine to state honestly.
3. In Render, go to your service → **Environment**, and update:
   - `PLAID_SECRET` → your new Development/Production secret
   - `PLAID_ENV` → `development` (or `production`, depending on what Plaid
     dashboard calls the tier you were given)
4. Click **Save Changes** — Render will redeploy automatically.
5. Now when you click "Connect your bank," you'll see a real bank login.
   Plaid gives every account **200 free live API calls per product** — more
   than enough for you and your dad to test with your real accounts.

---

## If something breaks

- Visit `https://your-render-url.onrender.com/api/health` directly in your
  browser. If you see `{"status":"ok",...}`, the server is alive and the
  problem is elsewhere. If you see an error page, the server itself didn't
  start — check the Render logs for red error text.
- Render's **Logs** tab (left sidebar of your service) shows everything the
  server prints — most errors will explain themselves there.
