// lottoscrape.js
require('dotenv').config();
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const LOTTO_URL = process.env.LOTTO_URL;

async function scrapeUaeLottoResults(url = LOTTO_URL) {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Handle age verification if present
        try {
            await page.waitForSelector('.age-content__primary-button.sensors-homepage-18over', { timeout: 4000 });
            await page.click('.age-content__primary-button.sensors-homepage-18over');
            // Give some time for the overlay to disappear
            await page.waitForTimeout(1200);
        } catch (e) {
            // Age popup not found, continue
        }

        // Wait for main draw results to load
        await page.waitForSelector('.draw-result_con', { timeout: 10000 });

        const html = await page.content();
        const $ = cheerio.load(html);

        // Extract draw number and date/time
        const drawNumber = $('.draw-result_con_drawno').first().text().replace('Draw No.:', '').trim();
        const drawDateTime = $('.draw-result_con_time').first().text().trim();

        // Main numbers
        const numbers = [];
        $('.draws-number-item_days').each((i, el) => {
            const num = $(el).text().trim();
            if (num) numbers.push(num);
        });
        const specialNumber = $('.draws-number-item_month > div').first().text().trim();

        // Prize tiers
        const prizeTiers = [];
        $('.draw-result_table_winners .list-item-wrap .list-item').each((i, el) => {
            const $tds = $(el).find('.item-cont');
            if ($tds.length >= 4) {
                prizeTiers.push({
                    tier: $tds.eq(0).text().trim(),
                    match: $tds.eq(1).text().trim(),
                    prize: $tds.eq(2).text().trim(),
                    winners: $tds.eq(3).text().trim(),
                });
            }
        });

        // Raffle winners
        const raffles = [];
        $('.raffle-content .list-item-wrap').each((i, wrap) => {
            $(wrap).find('.list-item').each((_, el) => {
                const $cols = $(el).find('.item-cont');
                if ($cols.length >= 2) {
                    raffles.push({
                        chanceId: $cols.eq(0).text().trim(),
                        amount: $cols.eq(1).text().trim(),
                    });
                }
            });
        });

        // Total winners
        const totalWinners = $('.winners_wrap .winners_value').first().text().replace('Total Winners:', '').trim();

        const result = {
            drawNumber,
            drawDateTime,
            numbers,
            specialNumber,
            prizeTiers,
            raffles,
            totalWinners,
            scrapedAt: new Date(),
        };

        console.log('[UAE Lotto Scrape]', JSON.stringify(result, null, 2));
        return result;
    } catch (err) {
        console.error('[UAE Lotto Scrape] ❌ Error:', err.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = scrapeUaeLottoResults;

// For CLI testing (optional)
if (require.main === module) {
    scrapeUaeLottoResults();
}
