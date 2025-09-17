const express = require('express');
const router = express.Router();
const scrapeAllSources = require('../scraper/scrape');
const testSingleSource = require('../scraper/testSingleSource');
const auth = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
    try {
        await scrapeAllSources();
        res.json({ message: 'Scraping completed.' });
    } catch (err) {
        console.error('Scraping failed:', err);
        res.status(500).json({ message: 'Scraping failed', error: err.message });
    }
});

const validateApiKey = (req, res, next) => {
    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== process.env.ADMIN_API_KEY) {
        return res.status(403).json({ message: 'Forbidden: Invalid API Key' });
    }
    next();
};

// GET endpoint for daily scraping (for Render Cron Job)
router.get('/hourly', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('hourly');
        res.send('✅ Hourly scrape complete');
    } catch (err) {
        console.error('❌ Hourly scrape error:', err);
        res.status(500).send('❌ Hourly scrape failed');
    }
});

// GET endpoint for 3-hour scraping
router.get('/3hours', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('3hours');
        res.send('✅ 3-hour scrape complete');
    } catch (err) {
        console.error('❌ 3-hour scrape error:', err);
        res.status(500).send('❌ 3-hour scrape failed');
    }
});

// GET endpoint for 6-hour scraping
router.get('/6hours', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('6hours');
        res.send('✅ 6-hour scrape complete');
    } catch (err) {
        console.error('❌ 6-hour scrape error:', err);
        res.status(500).send('❌ 6-hour scrape failed');
    }
});

// GET endpoint for 9-hour scraping
router.get('/9hours', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('9hours');
        res.send('✅ 9-hour scrape complete');
    } catch (err) {
        console.error('❌ 9-hour scrape error:', err);
        res.status(500).send('❌ 9-hour scrape failed');
    }
});

// GET endpoint for 12-hour scraping
router.get('/12hours', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('12hours');
        res.send('✅ 12-hour scrape complete');
    } catch (err) {
        console.error('❌ 12-hour scrape error:', err);
        res.status(500).send('❌ 12-hour scrape failed');
    }
});

router.get('/daily', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('daily');
        res.send('✅ Daily scrape complete');
    } catch (err) {
        console.error('❌ Daily scrape error:', err);
        res.status(500).send('❌ Daily scrape failed');
    }
});
// GET endpoint for weekly scraping (for Render Cron Job)
router.get('/weekly', validateApiKey, async (req, res) => {
    try {
        await scrapeAllSources('weekly');
        res.send('✅ Weekly scrape complete');
    } catch (err) {
        console.error('❌ Weekly scrape error:', err);
        res.status(500).send('❌ Weekly scrape failed');
    }
});

// POST endpoint for testing a single source
router.post('/test/:sourceId', validateApiKey, async (req, res) => {
    try {
        const { sourceId } = req.params;
        console.log(`🧪 Test scrape requested for source ID: ${sourceId}`);

        const testResults = await testSingleSource(sourceId);
        res.json({
            message: testResults.success ? '✅ Test completed successfully' : '⚠️ Test completed with issues',
            results: testResults
        });
    } catch (err) {
        console.error('❌ Test scrape error:', err);
        res.status(500).json({
            message: '❌ Test scrape failed',
            error: err.message,
            results: {
                success: false,
                errors: [err.message],
                steps: ['❌ Test failed during execution'],
                articles: []
            }
        });
    }
});

// Simple diagnostic endpoint
router.get('/test-endpoint', validateApiKey, (req, res) => {
    res.json({
        message: '✅ Test endpoint is working!',
        timestamp: new Date().toISOString(),
        url: req.originalUrl
    });
});

module.exports = router;