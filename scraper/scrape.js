const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const sendExpoNotification = require('../utils/sendExpoNotification');
const { scrapeReelsForSource } = require('./instagramReels');

async function fetchWithPuppeteer(url) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
        let lastCount = 0;
        for (let i = 0; i < 6; i++) {
            const currentCount = await page.$$eval('div[class*="m04n-"]', els => els.length);
            if (currentCount === lastCount) break;
            lastCount = currentCount;
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    } catch (err) {
        console.warn('Scroll error:', err.message);
    }

    const html = await page.content();
    return { html, page, browser };
}

/**
 * Scrapes all sources and sends a summary push notification with deep-link and action buttons
 */
async function scrapeAllSources(frequency = null) {
    let sources = await Source.find();
    if (frequency) sources = sources.filter(s => s.frequency === frequency);

    let totalNew = 0;
    let sampleArticle = null;

    for (const source of sources) {
        try {
            console.log(`Scraping ${source.name}`);
            let html, page, browser;
            if (source.name.toLowerCase().includes('gulfi news')) {
                ({ html, page, browser } = await fetchWithPuppeteer(source.url));
            } else {
                html = (await axios.get(source.url)).data;
            }

            const $ = cheerio.load(html);
            const listSel = source.listSelector || 'div[class*="m04n-"]';
            const linkSel = source.linkSelector || 'a';
            const links = [];
            $(listSel).each((_, el) => {
                const href = $(el).find(linkSel).attr('href');
                if (href) {
                    const url = href.startsWith('http')
                        ? href
                        : `${(source.baseUrl || source.url).replace(/\/$/, '')}${href}`;
                    links.push(url);
                }
            });
            if (browser) await browser.close();

            for (const link of links) {
                try {
                    const exists = await Article.findOne({ url: link });
                    if (exists) continue;

                    const pageHtml = source.name.toLowerCase().includes('gulfi news')
                        ? (await fetchWithPuppeteer(link)).html
                        : (await axios.get(link)).data;
                    const $$ = cheerio.load(pageHtml);

                    // Extract title and content
                    const title = $$(source.titleSelector || '.ORiM7').first().text().trim();
                    const content = $$(source.contentSelector || '.story-element.story-element-text p')
                        .map((_, p) => $$(p).text().trim())
                        .get()
                        .join('\n\n');

                    // Extract images
                    let images = $$(source.imageSelector || 'img')
                        .map((_, img) => $$(img).attr('src'))
                        .get()
                        .filter(Boolean)
                        .map(src => {
                            if (src.startsWith('//')) return 'https:' + src;
                            if (src.startsWith('/')) return `${source.baseUrl.replace(/\/$/, '')}${src}`;
                            return src;
                        });

                    // Fallback to Open Graph / Twitter meta
                    if (images.length === 0) {
                        const og = $$('meta[property="og:image"]').attr('content') || $$('meta[name="twitter:image"]').attr('content');
                        if (og) {
                            images.push(og.startsWith('//') ? 'https:' + og : og);
                        }
                    }

                    // Save article if valid
                    if (title && content) {
                        const newArticle = new Article({
                            title,
                            content,
                            url: link,
                            sourceId: source._id,
                            category: source.category,
                            publishedAt: new Date(),
                        });

                        if (images.length > 0) newArticle.image = images;
                        await newArticle.save();

                        totalNew++;
                        if (!sampleArticle) {
                            sampleArticle = newArticle;
                        }
                    }
                } catch (err) {
                    console.error(`Error on article ${link}:`, err.message);
                }
            }

            source.lastScraped = new Date();
            await source.save();
        } catch (err) {
            console.error(`Failed to scrape ${source.url}:`, err.message);
        }
    }
    if (source.instagramUsername) {
        console.log(`Scraping Reels for ${source.instagramUsername}`);
        const reels = await scrapeReelsForSource(
            source._id,
            source.instagramUsername
        );
        console.log(`  • ${reels.length} reels upserted`);
    }

    if (totalNew > 0 && sampleArticle) {
        const users = await User.find({ pushToken: { $exists: true, $ne: null } });
        const tokens = users.map(u => u.pushToken);

        // Truncate to, say, 140 chars so your notification body isn’t gigantic
        const snippet = sampleArticle.content.length > 140
            ? sampleArticle.content.slice(0, 140).trim() + '…'
            : sampleArticle.content;

        await sendExpoNotification(
            // Use the article’s title as the push title
            sampleArticle.title,
            // Use your snippet as the push body
            snippet,
            tokens,
            {
                // Deep-link into your app
                link: `gulfio://article/${sampleArticle._id}`,
                // Pass the image URL so Expo can render it
                imageUrl: sampleArticle.image && sampleArticle.image[0]
            },
            [
                { actionId: 'view', buttonTitle: 'Read Article' },
                { actionId: 'dismiss', buttonTitle: 'Dismiss' }
            ]
        );

        console.log(`Summary notification sent for ${totalNew} new articles.`);
    }
}

module.exports = scrapeAllSources;
