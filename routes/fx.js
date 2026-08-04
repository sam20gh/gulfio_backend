// routes/fx.js
//
// Daily foreign-exchange rates. The app never talks to the upstream provider
// directly — that endpoint rate limits by IP with a 20-minute ban, so a few
// thousand devices hitting it would take the feature down for everyone. All
// reads are served from our stored daily snapshot.
const express = require('express');
const {
    getLatestExchangeRates,
    fetchAndStoreExchangeRates,
} = require('../services/exchangeRates');
const ExchangeRate = require('../models/ExchangeRate');

const router = express.Router();

// GET /api/fx — latest daily snapshot (USD base, ~166 currencies).
router.get('/', async (req, res) => {
    try {
        const latest = await getLatestExchangeRates();
        if (!latest) {
            return res.status(404).json({ error: 'No exchange rate data available yet' });
        }
        res.json(latest);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/fx/history?days=30&symbols=INR,PKR — daily series for trend charts.
//
// `symbols` is strongly encouraged: the full snapshot is ~166 currencies, so an
// unfiltered 365-day request is several megabytes of JSON the client throws
// away. Filtering server-side keeps the chart request small on mobile data.
router.get('/history', async (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
        const symbols = (req.query.symbols || '')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);

        const docs = await ExchangeRate.find().sort({ date: -1 }).limit(days).lean();

        const results = docs.map((doc) => {
            const rates = symbols.length
                ? Object.fromEntries(
                      symbols
                          .filter((s) => doc.rates?.[s] != null)
                          .map((s) => [s, doc.rates[s]])
                  )
                : doc.rates;
            return { date: doc.date, base: doc.base, rates, source: doc.source };
        });

        res.json({ count: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/fx/refresh — admin-only manual refresh.
router.post('/refresh', async (req, res) => {
    if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const doc = await fetchAndStoreExchangeRates();
        res.json({ ok: true, data: doc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
