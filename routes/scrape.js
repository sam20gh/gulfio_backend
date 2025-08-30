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

// GET endpoint for hourly scraping (for Cloud Run Cron Job)
router.get('/hourly', validateApiKey, async (req, res) => {
    try {
        console.log('🚀 Starting hourly scrape...');
        
        // Send immediate response to prevent Cloud Run timeout
        res.send('✅ Hourly scrape started');
        
        // Run scraping in background (non-blocking)
        scrapeAllSources('hourly').then(() => {
            console.log('✅ Hourly scrape completed successfully');
        }).catch(err => {
            console.error('❌ Hourly scrape error:', err.message);
        });
        
    } catch (err) {
        console.error('❌ Hourly scrape startup error:', err);
        res.status(500).send('❌ Hourly scrape failed to start');
    }
});

// GET endpoint for daily scraping (for Cloud Run Cron Job)
router.get('/daily', validateApiKey, async (req, res) => {
    try {
        console.log('🚀 Starting daily scrape...');
        
        // Send immediate response to prevent Cloud Run timeout
        res.send('✅ Daily scrape started');
        
        // Run scraping in background (non-blocking)
        scrapeAllSources('daily').then(() => {
            console.log('✅ Daily scrape completed successfully');
        }).catch(err => {
            console.error('❌ Daily scrape error:', err.message);
        });
        
    } catch (err) {
        console.error('❌ Daily scrape startup error:', err);
        res.status(500).send('❌ Daily scrape failed to start');
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