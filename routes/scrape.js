const express = require('express');
const router = express.Router();
const scrapeAllSources = require('../scraper/scrape');
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

module.exports = router;