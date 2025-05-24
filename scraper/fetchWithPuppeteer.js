// scraper/fetchWithPuppeteer.js
const puppeteer = require('puppeteer');

async function fetchWithPuppeteer(url) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // You can add age gate logic here if you want it for all fetches

    const html = await page.content();
    await browser.close();
    return { html };
}

module.exports = fetchWithPuppeteer;
