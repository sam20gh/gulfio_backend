// routes/lotto.js
const express = require('express');
const scrapeUaeLottoResults = require('../scraper/lottoscrape');
const LottoResult = require('../models/LottoResult');
const NotificationService = require('../utils/notificationService');

const router = express.Router();

// GET latest draw
router.get('/latest', async (req, res) => {
    const result = await LottoResult.findOne().sort({ scrapedAt: -1 });
    if (!result) return res.status(404).json({ error: 'No result found' });
    res.json(result);
});

// GET all results with pagination
router.get('/all', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const results = await LottoResult.find()
            .sort({ scrapedAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await LottoResult.countDocuments();

        res.json({
            results,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET by draw number
router.get('/:drawNumber', async (req, res) => {
    const result = await LottoResult.findOne({ drawNumber: req.params.drawNumber });
    if (!result) return res.status(404).json({ error: 'No result for that draw' });
    res.json(result);
});

router.post('/scrape', async (req, res) => {
    // Security: check API key in header
    if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        console.log('[Lotto Scrape] Starting scrape process...');
        const result = await scrapeUaeLottoResults();
        if (!result) {
            console.error('[Lotto Scrape] Scraping returned null result');
            return res.status(500).json({ error: 'Scraping failed - no data returned' });
        }

        console.log('[Lotto Scrape] Successfully scraped data for draw:', result.drawNumber);

        // Upsert logic here (as in lotto-cron.js)...
        const existing = await LottoResult.findOne({ drawNumber: result.drawNumber });
        if (existing) {
            await LottoResult.updateOne({ drawNumber: result.drawNumber }, result);
            console.log('[Lotto Scrape] Updated existing result for draw:', result.drawNumber);
        } else {
            await LottoResult.create(result);
            console.log('[Lotto Scrape] Created new result for draw:', result.drawNumber);
        }

        // Phase 0: policy-filtered lotto push (settings, dedupe per draw,
        // quiet hours, daily budget, holdout).
        const notifyResult = await NotificationService.sendLottoResultNotification(result);
        console.log('[Lotto Scrape] Notification result:', JSON.stringify(notifyResult));

        return res.json({ success: true, result });
    } catch (err) {
        console.error('[Lotto Scrape] ❌ Error:', err.message);
        console.error('[Lotto Scrape] Stack trace:', err.stack);

        // Return specific error information
        let errorMessage = err.message;
        if (errorMessage.includes('Could not find Chrome')) {
            errorMessage = 'Chrome browser not available in deployment environment. Please check Docker configuration.';
        }

        return res.status(500).json({
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

module.exports = router;
