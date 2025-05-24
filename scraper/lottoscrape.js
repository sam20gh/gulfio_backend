// scraper/lottoscrape.js
require('dotenv').config();
const cheerio = require('cheerio');
const fetchWithPuppeteer = require('./fetchWithPuppeteer');

const LOTTO_URL = process.env.LOTTO_URL;

async function scrapeUaeLottoResults(url = LOTTO_URL) {
    try {
        const { html } = await fetchWithPuppeteer(url);

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
    }
}

module.exports = scrapeUaeLottoResults;

if (require.main === module) {
    scrapeUaeLottoResults();
}
