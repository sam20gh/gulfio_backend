const puppeteer = require('puppeteer');

async function fetchWithPuppeteer(url, options = {}) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Return early if the caller wants to interact before closing
    if (options.returnPage) {
        return { browser, page };
    }

    const html = await page.content();
    await browser.close();
    return { html };
}

module.exports = fetchWithPuppeteer;
