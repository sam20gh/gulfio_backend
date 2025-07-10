// routes/lotto.js
const express = require('express');
const scrapeUaeLottoResults = require('../scraper/lottoscrape');
const LottoResult = require('../models/LottoResult');
const User = require('../models/User');
const sendExpoNotification = require('../utils/sendExpoNotification');

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
        const result = await scrapeUaeLottoResults();
        if (!result) return res.status(500).json({ error: 'Scraping failed' });

        // Upsert logic here (as in lotto-cron.js)...
        const existing = await LottoResult.findOne({ drawNumber: result.drawNumber });
        if (existing) {
            await LottoResult.updateOne({ drawNumber: result.drawNumber }, result);
        } else {
            await LottoResult.create(result);
        }

        // Push notification logic (as before)...
        const users = await User.find({ pushToken: { $exists: true, $ne: null } });
        const tokens = users.map(u => u.pushToken);
        if (tokens.length) {
            const title = `UAE Lotto Draw #${result.drawNumber} Results`;
            const body = `Numbers: ${result.numbers.join(', ')} | Special: ${result.specialNumber} | Jackpot: ${result.prizeTiers[0]?.prize || ''}`;
            const data = {
                drawNumber: result.drawNumber,
                link: `gulfio://lotto/${result.drawNumber}`,
                numbers: result.numbers,
                specialNumber: result.specialNumber,
                prizeTiers: result.prizeTiers,
                raffles: result.raffles,
                totalWinners: result.totalWinners
            };
            await sendExpoNotification(title, body, tokens, data);
        }

        return res.json({ success: true, result });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
