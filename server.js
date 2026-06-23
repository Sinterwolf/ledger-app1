// =========================================================
// LEDGER APP SERVER
// This is the "backend" — it talks to Plaid securely so your
// bank login details never pass through your browser or get
// stored anywhere except directly with Plaid.
// =========================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

// Use an absolute path (built from this file's own location) rather than a
// relative one — relative paths can break depending on which folder the
// hosting service actually starts the server from.
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Explicit fallback: if someone visits the homepage "/", always serve
// index.html directly. This guarantees the homepage works even if static
// file serving above has any path issue.
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// -----------------------------------------------------------
// PLAID SETUP
// PLAID_ENV controls which Plaid environment we talk to:
//   "sandbox"     = fake banks, fake data, totally free, unlimited use
//   "development" / "production" = real banks, real data (limited free calls)
// You set these as "Environment Variables" in Render — never written
// directly in this file, so your secret keys don't end up on GitHub.
// -----------------------------------------------------------
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

// In-memory storage of access tokens, keyed by a simple user id.
// NOTE: this is fine for a personal/family project with a couple of
// users. A real public product would use a real database instead,
// since this resets every time the server restarts.
const accessTokens = {};

// -----------------------------------------------------------
// 1. CREATE LINK TOKEN
// The frontend calls this first. It asks Plaid for a temporary
// "link_token" that's used to open the Plaid bank-connection popup.
// -----------------------------------------------------------
app.post('/api/create_link_token', async (req, res) => {
  try {
    const userId = req.body.userId || 'default_user';

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Ledger',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Error creating link token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// -----------------------------------------------------------
// 2. EXCHANGE PUBLIC TOKEN
// After someone successfully connects their bank in the Plaid
// popup, the frontend sends us a temporary "public_token". We
// trade that for a permanent "access_token" which is what we use
// going forward to fetch their transactions. The access_token
// NEVER goes back to the browser — it stays only on this server.
// -----------------------------------------------------------
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const { public_token, userId } = req.body;

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = response.data.access_token;
    accessTokens[userId || 'default_user'] = accessToken;

    res.json({ success: true });
  } catch (err) {
    console.error('Error exchanging token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// -----------------------------------------------------------
// 3. FETCH TRANSACTIONS + DETECT SUBSCRIPTIONS (DIY version)
//
// NOTE: Plaid has an official "/transactions/recurring/get" endpoint
// that does this automatically, but it requires requesting separate
// product access from Plaid first — an extra approval step. To keep
// this $0-and-no-waiting, we instead pull raw transactions with the
// standard /transactions/sync endpoint (available on every account,
// no extra approval) and detect recurring charges ourselves with
// simple grouping logic below.
// -----------------------------------------------------------
app.get('/api/transactions/:userId?', async (req, res) => {
  try {
    const userId = req.params.userId || 'default_user';
    const accessToken = accessTokens[userId];

    if (!accessToken) {
      return res.status(400).json({ error: 'No connected bank account for this user yet.' });
    }

    // Pull all available transactions via sync (paginating if needed).
    let allTransactions = [];
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const syncResponse = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor: cursor,
      });
      allTransactions = allTransactions.concat(syncResponse.data.added);
      hasMore = syncResponse.data.has_more;
      cursor = syncResponse.data.next_cursor;
    }

    const subscriptions = detectRecurringCharges(allTransactions);
    res.json({ subscriptions });
  } catch (err) {
    console.error('Error fetching transactions:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// -----------------------------------------------------------
// Recurring-charge detection logic.
// Groups transactions by merchant name, looks for ones that repeat
// at least twice with a similar amount, estimates frequency from the
// average gap between charges, and flags anything overdue as "idle."
// This is intentionally simple — a real product would refine this a
// lot — but it's enough to demonstrate the concept end-to-end.
// -----------------------------------------------------------
function detectRecurringCharges(transactions) {
  // Only look at money going OUT (positive amount = outflow in Plaid's model)
  const outflows = transactions.filter(t => t.amount > 0 && t.merchant_name);

  // Group by merchant name
  const groups = {};
  outflows.forEach(t => {
    const key = t.merchant_name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const subscriptions = [];

  for (const merchant in groups) {
    const charges = groups[merchant].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Need at least 2 charges to call it "recurring"
    if (charges.length < 2) continue;

    // Check amounts are similar (within 10%) across charges
    const amounts = charges.map(c => c.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amountsConsistent = amounts.every(a => Math.abs(a - avgAmount) / avgAmount < 0.10);
    if (!amountsConsistent) continue;

    // Estimate frequency from average gap between charges, in days
    const gaps = [];
    for (let i = 1; i < charges.length; i++) {
      const days = (new Date(charges[i].date) - new Date(charges[i - 1].date)) / (1000 * 60 * 60 * 24);
      gaps.push(days);
    }
    const avgGapDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    let frequency = 'MONTHLY';
    if (avgGapDays <= 10) frequency = 'WEEKLY';
    else if (avgGapDays <= 20) frequency = 'BIWEEKLY';
    else if (avgGapDays <= 45) frequency = 'MONTHLY';
    else if (avgGapDays <= 100) frequency = 'QUARTERLY';
    else frequency = 'ANNUAL';

    const lastCharge = charges[charges.length - 1];
    const daysSinceLastCharge = Math.floor((Date.now() - new Date(lastCharge.date).getTime()) / (1000 * 60 * 60 * 24));

    // Idle if we're overdue for the next expected charge by a good margin
    const isIdle = daysSinceLastCharge > avgGapDays + 30;

    subscriptions.push({
      merchant,
      averageAmount: avgAmount,
      frequency,
      lastDate: lastCharge.date,
      daysSinceLastCharge,
      chargeCount: charges.length,
      isIdle,
    });
  }

  return subscriptions;
}

// -----------------------------------------------------------
// Health check — lets you confirm the server is alive by just
// visiting the URL in a browser.
// -----------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: PLAID_ENV });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ledger server running on port ${PORT} (Plaid env: ${PLAID_ENV})`);
});
