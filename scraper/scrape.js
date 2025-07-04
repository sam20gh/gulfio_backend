// scraper/scrape.js
const axios = require('axios');
const cheerio = require('cheerio');
const fetchWithPuppeteer = require('./fetchWithPuppeteer');
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const sendExpoNotification = require('../utils/sendExpoNotification');
const { scrapeReelsForSource } = require('./instagramReels');
const scrapeUaeLottoResults = require('./lottoscrape');
const LottoResult = require('../models/LottoResult');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { scrapeYouTubeShortsViaRSS } = require('./youtubeRSSShortsScraper.js'); // Using RSS-based scraper
const { scrapeYouTubeForSource } = require('./youtubeScraper');

async function scrapeAllSources(frequency = null) {
    let sources = await Source.find();
    if (frequency) sources = sources.filter(s => s.frequency === frequency);

    let totalNew = 0;
    let sampleArticle = null;

    for (const source of sources) {
        try {
            console.log(`Scraping ${source.name}`);
            let html;
            if (source.name.toLowerCase().includes('gulfi news')) {
                ({ html } = await fetchWithPuppeteer(source.url));
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

            for (const link of links) {
                try {
                    const exists = await Article.findOne({ url: link });
                    if (exists) continue;

                    let pageHtml;
                    if (source.name.toLowerCase().includes('gulfi news')) {
                        ({ html: pageHtml } = await fetchWithPuppeteer(link));
                    } else {
                        pageHtml = (await axios.get(link)).data;
                    }
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
                    let embedding = [];
                    try {
                        const embedInput = `${title}\n\n${content?.slice(0, 512) || ''}`;
                        embedding = await getDeepSeekEmbedding(embedInput);
                        console.log('✅ Got embedding for:', title);
                    } catch (err) {
                        console.warn('❌ Embedding error for article:', title, err.message);
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
                            language: source.language || "english",
                            embedding
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

            // if (source.instagramUsername) {
            //     console.log(`Scraping Reels for ${source.instagramUsername}`);
            //     const reels = await scrapeReelsForSource(
            //         source._id,
            //         source.instagramUsername
            //     );
            //     console.log(`  • ${reels.length} reels upserted`);
            // }
            if (source.youtubeChannelId) {
                console.log(`Scraping YouTube Shorts (RSS-based) for ${source.name}`);
                // const ytReels = await scrapeYouTubeShortsViaRSS(source);
                // console.log(`  • ${ytReels.length} YouTube Shorts upserted via RSS`);
            }
            try {
                console.log(`Scraping full YouTube videos for ${source.name}`);
                const savedVideos = await scrapeYouTubeForSource(source._id, source.youtubeChannelId);
                console.log(`  • ${savedVideos.length} videos stored in Video collection`);
            } catch (err) {
                console.warn(`⚠️ Failed to scrape YouTube videos for ${source.name}:`, err.message);
            }

            source.lastScraped = new Date();
            await source.save();
        } catch (err) {
            console.error(`Failed to scrape ${source.url}:`, err.message);
        }
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

    // --- Lotto scraping integration ---
    if (!frequency || frequency === 'daily') {
        try {
            console.log('>>> About to scrape Lotto results, frequency:', frequency);
            const result = await scrapeUaeLottoResults();
            console.log('>>> Lotto scrape result:', result);

            if (result) {
                const existing = await LottoResult.findOne({ drawNumber: result.drawNumber });
                if (existing) {
                    await LottoResult.updateOne({ drawNumber: result.drawNumber }, result);
                    console.log('✅ Updated Lotto draw:', result.drawNumber);
                } else {
                    await LottoResult.create(result);
                    console.log('✅ Saved new Lotto draw:', result.drawNumber);
                }

                // Expo push (optional, only for new draw)
                const users = await User.find({ pushToken: { $exists: true, $ne: null } });
                const tokens = users.map(u => u.pushToken);
                if (tokens.length) {
                    const title = `UAE Lotto Draw #${result.drawNumber} Results`;
                    const body = `Numbers: ${result.numbers.join(', ')} | Special: ${result.specialNumber} | Jackpot: ${result.prizeTiers[0]?.prize || ''}`;
                    const data = {
                        drawNumber: result.drawNumber,
                        link: `gulfio://lotto/${result.drawNumber}`,
                        numbers: result.numbers,
                        specialNumber: result.specialNumber,
                        prizeTiers: result.prizeTiers,
                        raffles: result.raffles,
                        totalWinners: result.totalWinners
                    };
                    await sendExpoNotification(title, body, tokens, data);
                }
            } else {
                console.warn('❌ Lotto result could not be scraped.');
            }
            console.log('>>> Lotto block finished');
        } catch (e) {
            console.error('❌ Lotto scraping error:', e);
        }
    }
}

module.exports = scrapeAllSources;
