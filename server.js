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
const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());

// -----------------------------------------------------------
// REDIS SETUP
// Upstash Redis persists accessTokens and paidSubscribers across
// server restarts and Render sleep/wake cycles, replacing the
// previous in-memory objects that wiped on every restart.
// -----------------------------------------------------------
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function accessTokenKey(userId) { return `access_token:${userId}`; }
function subscriberKey(userId) { return `subscriber:${userId}`; }

// Upstash REST API may deserialize 'true' as a boolean; handle both.
function isSubscriberValue(val) {
  return val === true || val === 'true';
}

// -----------------------------------------------------------
// STRIPE WEBHOOK ROUTE — defined here, BEFORE the global JSON parser
// -----------------------------------------------------------
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Webhook received — event.type:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.userId || 'default_user';
    await redis.set(subscriberKey(userId), 'true');
    console.log(`Payment confirmed for user: ${userId}`);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId;
    if (userId) {
      await redis.del(subscriberKey(userId));
      console.log(`Subscription canceled for user: ${userId}`);
    }
  }

  res.json({ received: true });
});

// All other routes use normal JSON parsing — registered AFTER the
// webhook route above, so it doesn't interfere with that one.
app.use(express.json());

const publicPath = __dirname;
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// -----------------------------------------------------------
// PLAID SETUP
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

// -----------------------------------------------------------
// STRIPE SETUP
// -----------------------------------------------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// -----------------------------------------------------------
// 1. CREATE LINK TOKEN
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
// -----------------------------------------------------------
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const { public_token, userId } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    await redis.set(accessTokenKey(userId || 'default_user'), accessToken);
    res.json({ success: true });
  } catch (err) {
    console.error('Error exchanging token:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// -----------------------------------------------------------
// 3. FETCH TRANSACTIONS + DETECT SUBSCRIPTIONS
// -----------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllTransactions(accessToken) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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

      return allTransactions;
    } catch (err) {
      const code = err.response?.data?.error_code;
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2) {
        console.log('Plaid data changed during pagination, retrying...');
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
}

app.get('/api/transactions/:userId?', async (req, res) => {
  try {
    const userId = req.params.userId || 'default_user';
    const accessToken = await redis.get(accessTokenKey(userId));

    if (!accessToken) {
      return res.status(400).json({ error: 'No connected bank account for this user yet.' });
    }

    let allTransactions = await fetchAllTransactions(accessToken);

    let attempts = 0;
    while (allTransactions.length === 0 && attempts < 4) {
      await sleep(2000);
      allTransactions = await fetchAllTransactions(accessToken);
      attempts++;
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
// -----------------------------------------------------------
function detectRecurringCharges(transactions) {
  const outflows = transactions.filter(t => t.amount > 0 && t.merchant_name);

  const groups = {};
  outflows.forEach(t => {
    const key = t.merchant_name;
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  const subscriptions = [];

  for (const merchant in groups) {
    const charges = groups[merchant].sort((a, b) => new Date(a.date) - new Date(b.date));
    if (charges.length < 2) continue;

    const amounts = charges.map(c => c.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const amountsConsistent = amounts.every(a => Math.abs(a - avgAmount) / avgAmount < 0.10);
    if (!amountsConsistent) continue;

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
    let isIdle = daysSinceLastCharge > avgGapDays + 30;

    if (process.env.FORCE_IDLE_FOR_TESTING === 'true' && subscriptions.length === 0) {
      isIdle = true;
    }

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
// Health check
// -----------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: PLAID_ENV,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
  });
});

// -----------------------------------------------------------
// STRIPE: CREATE CHECKOUT SESSION
// -----------------------------------------------------------
app.post('/api/create_checkout_session', async (req, res) => {
  try {
    const userId = req.body.userId || 'default_user';
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Ledger Plus — cancel idle subscriptions' },
          unit_amount: 1500,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      client_reference_id: userId,
      metadata: { userId },
      success_url: `${origin}/?subscribed=true`,
      cancel_url: `${origin}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// -----------------------------------------------------------
// STRIPE: CHECK SUBSCRIPTION STATUS
// -----------------------------------------------------------
app.get('/api/subscription-status/:userId?', async (req, res) => {
  const userId = req.params.userId || 'default_user';
  const val = await redis.get(subscriberKey(userId));
  console.log(`Subscription status check for ${userId}: val=${JSON.stringify(val)} type=${typeof val}`);
  res.json({ isSubscribed: isSubscriberValue(val) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ledger server running on port ${PORT} (Plaid env: ${PLAID_ENV})`);
});
