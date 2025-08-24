const express = require('express');
const router = express.Router();
const fetchWithPuppeteer = require('../scraper/fetchWithPuppeteer');

// Debug endpoint to test Puppeteer functionality
router.get('/test-puppeteer', async (req, res) => {
    try {
        console.log('🧪 Testing Puppeteer functionality...');

        const testUrl = req.query.url || 'https://example.com';
        console.log(`🎯 Testing URL: ${testUrl}`);

        const startTime = Date.now();
        const { html } = await fetchWithPuppeteer(testUrl);
        const duration = Date.now() - startTime;

        const response = {
            success: true,
            message: '✅ Puppeteer is working correctly!',
            testUrl: testUrl,
            htmlLength: html.length,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString(),
            htmlPreview: html.substring(0, 500) + '...'
        };

        console.log('✅ Puppeteer test successful:', response);
        res.json(response);

    } catch (error) {
        console.error('❌ Puppeteer test failed:', error);

        const response = {
            success: false,
            message: '❌ Puppeteer test failed',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        };

        res.status(500).json(response);
    }
});

// Test Chrome detection
router.get('/chrome-info', async (req, res) => {
    try {
        const puppeteer = require('puppeteer');
        const fs = require('fs');

        const chromeInfo = {
            puppeteerExecutablePath: null,
            chromeExists: {},
            recommendation: ''
        };

        // Test Puppeteer's bundled Chrome
        try {
            chromeInfo.puppeteerExecutablePath = puppeteer.executablePath();
            chromeInfo.chromeExists.puppeteerBundled = fs.existsSync(chromeInfo.puppeteerExecutablePath);
        } catch (err) {
            chromeInfo.puppeteerExecutablePath = 'Error: ' + err.message;
        }

        // Test system Chrome paths
        const systemPaths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium'
        ];

        for (const path of systemPaths) {
            chromeInfo.chromeExists[path] = fs.existsSync(path);
        }

        // Recommendation
        if (chromeInfo.chromeExists.puppeteerBundled) {
            chromeInfo.recommendation = '✅ Puppeteer bundled Chrome found - should work';
        } else if (chromeInfo.chromeExists['/usr/bin/google-chrome-stable']) {
            chromeInfo.recommendation = '✅ System Chrome found - should work';
        } else {
            chromeInfo.recommendation = '⚠️ No Chrome found - may need to run: npx puppeteer browsers install chrome';
        }

        res.json(chromeInfo);

    } catch (error) {
        res.status(500).json({
            error: error.message,
            message: 'Failed to check Chrome installation'
        });
    }
});

module.exports = router;
