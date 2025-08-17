// Test script to verify Puppeteer Chrome installation
const puppeteer = require('puppeteer');

async function testPuppeteer() {
    console.log('🧪 Testing Puppeteer Chrome installation...');

    try {
        console.log('📍 Puppeteer executable path:', puppeteer.executablePath());

        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.goto('https://example.com', { waitUntil: 'networkidle2', timeout: 10000 });

        const title = await page.title();
        console.log('✅ Successfully loaded page. Title:', title);

        await browser.close();
        console.log('✅ Puppeteer test completed successfully!');

    } catch (error) {
        console.error('❌ Puppeteer test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

testPuppeteer();
