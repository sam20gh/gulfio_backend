const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Source = require('../models/Source');
const Article = require('../models/Article');

async function fetchWithPuppeteer(url) {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
        let lastCount = 0;
        for (let i = 0; i < 6; i++) {
            const currentCount = await page.$$eval('div[class*="m04n-"]', els => els.length);
            console.log(`Scroll #${i + 1} – found ${currentCount} articles`);
            if (currentCount === lastCount) break;
            lastCount = currentCount;
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    } catch (err) {
        console.warn('⚠️ Error during scroll:', err.message);
    }

    const html = await page.content();
    return { html, page, browser };
}

async function scrapeAllSources(frequency = null) {
    let sources = await Source.find();

    if (frequency) {
        sources = sources.filter(source => source.frequency === frequency);
    }

    for (const source of sources) {
        try {
            const isDynamicSite = source.name.toLowerCase().includes('gulf news');
            console.log(`Scraping source: ${source.name}`);

            let homepageHtml, page, browser;
            if (isDynamicSite) {
                const puppeteerResult = await fetchWithPuppeteer(source.url);
                homepageHtml = puppeteerResult.html;
                page = puppeteerResult.page;
                browser = puppeteerResult.browser;
            } else {
                homepageHtml = (await axios.get(source.url)).data;
            }

            let articleLinks = [];

            if (isDynamicSite) {
                articleLinks = await page.evaluate(() => {
                    const anchors = Array.from(document.querySelectorAll('div[class*="m04n-"] a'));
                    return anchors.map(a =>
                        a.href.startsWith('http') ? a.href : `https://gulfnews.com${a.getAttribute('href')}`
                    );
                });
                await browser.close();
            } else {
                const $ = cheerio.load(homepageHtml);
                const listSelector = source.listSelector || 'div[class*="m04n-"]';
                const linkSelector = source.linkSelector || 'a';
                $(listSelector).each((_, el) => {
                    const href = $(el).find(linkSelector).attr('href');
                    const fullUrl = href?.startsWith('http') ? href : `${source.url.replace(/\/$/, '')}${href}`;
                    if (fullUrl) articleLinks.push(fullUrl);
                });
            }

            console.log(`[${source.name}] Found ${articleLinks.length} articles`);

            for (const link of articleLinks) {
                try {
                    const existing = await Article.findOne({ url: link });
                    if (existing) continue;

                    const articleHtml = isDynamicSite
                        ? (await fetchWithPuppeteer(link)).html
                        : (await axios.get(link)).data;

                    const $$ = cheerio.load(articleHtml);

                    const title = $$(source.titleSelector || '.ORiM7').first().text().trim();
                    const images = $$(source.imageSelector || '.jT9Gr img')
                        .map((_, el) => $$(el).attr('src'))
                        .get()
                        .filter(Boolean)
                        .map(src => (src.startsWith('//') ? 'https:' + src : src));

                    const content = $$(source.contentSelector || '.story-element.story-element-text p')
                        .map((_, p) => $$(p).text().trim())
                        .get()
                        .join('\n\n');

                    console.log(`[${source.name}] Visiting: ${link}`);
                    console.log(`[${source.name}] Title: ${title}`);
                    console.log(`[${source.name}] Content length: ${content.length}`);

                    if (title && content) {
                        const article = new Article({
                            title,
                            content,
                            url: link,
                            sourceId: source._id,
                            category: source.category,
                            publishedAt: new Date(),
                            ...(images.length > 0 && { image: images })
                        });

                        await article.save();
                        console.log(`[${source.name}] ✅ Saved: ${title}`);
                    }
                } catch (err) {
                    console.error(`[${source.name}] ❌ Error scraping article: ${link}`, err.message);
                }
            }

            source.lastScraped = new Date();
            await source.save();
        } catch (err) {
            console.error(`❌ Failed to scrape ${source.url}:`, err.message);
        }
    }
}

module.exports = scrapeAllSources;
