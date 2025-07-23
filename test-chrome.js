// test-chrome.js
// Simple script to test if Chrome/Puppeteer is working correctly

const fetchWithPuppeteer = require('./scraper/fetchWithPuppeteer');

async function testChrome() {
    console.log('🧪 Testing Chrome/Puppeteer setup...');

    try {
        const result = await fetchWithPuppeteer('https://www.google.com');
        if (result && result.html && result.html.includes('Google')) {
            console.log('✅ Chrome/Puppeteer is working correctly!');
            console.log(`📄 Retrieved HTML content (${result.html.length} characters)`);
        } else {
            console.log('⚠️  Chrome launched but didn\'t get expected content');
        }
    } catch (error) {
        console.error('❌ Chrome/Puppeteer test failed:');
        console.error(error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    testChrome();
}

module.exports = testChrome;
