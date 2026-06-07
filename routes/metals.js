// routes/metals.js
const express = require('express');
const {
    getLatestMetalPrices,
    fetchAndStoreMetalPrices,
} = require('../services/metalPrices');
const MetalPrice = require('../models/MetalPrice');

const router = express.Router();

// GET /api/metals — latest daily snapshot (gold + silver in USD + live FX rates).
router.get('/', async (req, res) => {
    try {
        const latest = await getLatestMetalPrices();
        if (!latest) {
            return res.status(404).json({ error: 'No metal price data available yet' });
        }
        res.json(latest);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/metals/history?days=30 — recent snapshots for trends/sparklines.
router.get('/history', async (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
        const results = await MetalPrice.find().sort({ date: -1 }).limit(days).lean();
        res.json({ count: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/metals/refresh — admin-only manual refresh (consumes GoldAPI quota).
router.post('/refresh', async (req, res) => {
    if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const doc = await fetchAndStoreMetalPrices();
        res.json({ ok: true, data: doc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
