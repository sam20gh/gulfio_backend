// scraper/lottoscrape.js
// Lucky Day lottery results scraper - draws every Saturday at 16:30 UAE time
require('dotenv').config();
const cheerio = require('cheerio');
const fetchWithPuppeteer = require('./fetchWithPuppeteer');

const LOTTO_URL = process.env.LOTTO_URL || 'https://www.theuaelottery.ae/lottery/luckyday/results';

async function scrapeUaeLottoResults(url = LOTTO_URL) {
    try {
        console.log('[UAE Lotto Scrape] 🎰 Starting scrape from:', url);

        // Use enhanced fetch with proper wait time for SPA content
        const { html } = await fetchWithPuppeteer(url, {
            waitForSelector: '.draw-result_content', // Wait for main content container
            waitTime: 10000, // Wait 10 seconds for content to load
            additionalDelay: 3000 // Additional 3 seconds after selector is found
        });

        const $ = cheerio.load(html);

        // Extract draw number - format: "Draw No.: 260117"
        const drawNumber = $('.draw-result_con_drawno').first().text().replace('Draw No.:', '').trim();

        // Extract date/time - format: "Saturday 16:30, 17/01/2026"
        const drawDateTime = $('.draw-result_con_time').first().text().trim();

        console.log('[UAE Lotto Scrape] 📅 Draw:', drawNumber, 'Date:', drawDateTime);

        // Main numbers - look for draws-number-item_days class (may include _61 or _lg suffixes)
        const numbers = [];
        $('[class*="draws-number-item_days"]').each((i, el) => {
            // Skip if it's the month/special number
            if ($(el).attr('class')?.includes('month')) return;
            const num = $(el).text().trim();
            if (num && /^\d+$/.test(num)) numbers.push(num);
        });

        // Special number (the red ball) - inside draws-number-item_month
        const specialNumberEl = $('[class*="draws-number-item_month"]').first();
        const specialNumber = specialNumberEl.find('div').first().text().trim() || specialNumberEl.text().trim();

        console.log('[UAE Lotto Scrape] 🔢 Numbers:', numbers.join(', '), '| Special:', specialNumber);

        // Prize tiers - from detail-list within draw-result_table_winners
        const prizeTiers = [];
        $('.draw-result_table_winners .detail-list .list-item-wrap .list-item').each((i, el) => {
            const $cols = $(el).find('.item-cont');
            if ($cols.length >= 4) {
                const tier = $cols.eq(0).text().trim();
                const match = $cols.eq(1).text().trim();
                const prize = $cols.eq(2).text().trim();
                const winners = $cols.eq(3).text().trim();

                // Only add if we have valid data (not header row)
                if (tier && match && prize) {
                    prizeTiers.push({ tier, match, prize, winners });
                }
            }
        });

        console.log('[UAE Lotto Scrape] 🏆 Prize tiers found:', prizeTiers.length);

        // Raffle winners - from raffle-content section
        const raffles = [];
        $('.raffle-content .detail-list .list-item-wrap .list-item').each((i, el) => {
            const $cols = $(el).find('.item-cont');
            if ($cols.length >= 2) {
                const chanceId = $cols.eq(0).text().trim();
                const amount = $cols.eq(1).text().trim();

                // Only add if we have valid data
                if (chanceId && amount && chanceId.length > 0) {
                    raffles.push({ chanceId, amount });
                }
            }
        });

        console.log('[UAE Lotto Scrape] 🎫 Raffle winners found:', raffles.length);

        // Total winners - format: "Total Winners: 6,185"
        const totalWinnersText = $('.winners_value').first().text();
        const totalWinners = totalWinnersText.replace('Total Winners:', '').trim();

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

        console.log('[UAE Lotto Scrape] ✅ Successfully scraped draw #' + drawNumber);
        console.log('[UAE Lotto Scrape]', JSON.stringify(result, null, 2));
        return result;
    } catch (err) {
        console.error('[UAE Lotto Scrape] ❌ Error:', err.message);
        console.error('[UAE Lotto Scrape] Stack:', err.stack);
        return null;
    }
}

module.exports = scrapeUaeLottoResults;

if (require.main === module) {
    scrapeUaeLottoResults();
}
