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
const mongoose = require('mongoose');

async function scrapeAllSources(frequency = null) {
    console.log(`🚀 Starting scrapeAllSources with frequency: ${frequency}`);
    console.log(`🔗 MongoDB connection state: ${mongoose.connection.readyState} (0=disconnected, 1=connected, 2=connecting, 3=disconnecting)`);
    console.log(`🌐 MONGO_URI exists: ${!!process.env.MONGO_URI}`);
    console.log(`🌐 MONGO_URI (masked): ${process.env.MONGO_URI ? process.env.MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : 'undefined'}`);

    if (mongoose.connection.readyState !== 1) {
        console.log('⚠️ MongoDB not connected inside scraper. Connecting now...');
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
            console.log('✅ MongoDB connected inside scraper.');
            console.log(`📊 New connection state: ${mongoose.connection.readyState}`);
        } catch (connectError) {
            console.error('❌ MongoDB connection failed:', connectError);
            throw connectError;
        }
    } else {
        console.log('✅ MongoDB already connected inside scraper.');
    }

    console.log('📋 Fetching sources from database...');
    let sources = await Source.find();
    console.log(`📊 Found ${sources.length} total sources`);
    if (frequency) {
        sources = sources.filter(s => s.frequency === frequency);
        console.log(`📊 Filtered to ${sources.length} sources with frequency: ${frequency}`);
    }

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
                if (href && href !== ':' && href !== '') {
                    const url = href.startsWith('http')
                        ? href
                        : `${(source.baseUrl || source.url).replace(/\/$/, '')}${href.startsWith('/') ? href : '/' + href}`;
                    links.push(url);
                } else {
                    console.warn(`Skipped invalid href: "${href}" for source: ${source.name}`);
                }
            });

            console.log(`Found ${links.length} links for ${source.name}`);
            if (links.length > 0) {
                console.log(`Sample links: ${links.slice(0, 3).join(', ')}`);
            }

            for (const link of links) {
                try {
                    console.log(`🔍 Checking if article exists: ${link}`);
                    const exists = await Article.findOne({ url: link });
                    if (exists) {
                        console.log(`⏭️ Article already exists, skipping: ${link}`);
                        continue;
                    }
                    console.log(`🆕 New article found, processing: ${link}`);

                    let pageHtml;
                    if (source.name.toLowerCase().includes('gulfi news')) {
                        const { browser, page } = await fetchWithPuppeteer(source.url, { returnPage: true });

                        try {
                            // 🛂 Try to click the consent button if present
                            const consentSelector = 'button.fc-button.fc-cta-consent.fc-primary-button';
                            const consentButton = await page.$(consentSelector);
                            if (consentButton) {
                                console.log('🛂 Clicking consent button...');
                                await page.click(consentSelector);
                                await page.waitForTimeout(800); // allow modal to disappear
                            }

                            const html = await page.content();
                            await browser.close();
                            // Attach html back to use as expected
                            html && (globalThis.lastFetchedHtml = html); // temporary cache
                        } catch (err) {
                            console.warn('⚠️ Error handling consent popup:', err.message);
                            await browser.close();
                        }

                        html = globalThis.lastFetchedHtml;
                    }
                    else {
                        pageHtml = (await axios.get(link)).data;
                    }
                    const $$ = cheerio.load(pageHtml);

                    console.log(`📝 Extracting content using selectors - Title: "${source.titleSelector || '.ORiM7'}", Content: "${source.contentSelector || '.story-element.story-element-text p'}"`);

                    // Extract title and content
                    const title = $$(source.titleSelector || '.ORiM7').first().text().trim();
                    const content = $$(source.contentSelector || '.story-element.story-element-text p')
                        .map((_, p) => $$(p).text().trim())
                        .get()
                        .join('\n\n');

                    console.log(`📊 Extracted - Title length: ${title.length}, Content length: ${content.length}`);

                    // Extract images
                    let images = $$(source.imageSelector || 'img')
                        .map((_, img) => $$(img).attr('src'))
                        .get()
                        .filter(Boolean)
                        .map(src => {
                            // 🔧 Fix low resolution by replacing width parameter
                            src = src.replace(/w=\d+/g, 'w=800');

                            // 🌐 Handle different URL types
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
                        console.log(`📝 Attempting to save article: "${title.slice(0, 50)}..." for source: ${source.name}`);
                        console.log(`📋 Article details - URL: ${link}, Category: ${source.category}, Language: ${source.language || "english"}`);
                        console.log(`🖼️ Images found: ${images.length}`);
                        console.log(`🔗 Embedding length: ${embedding.length}`);

                        try {
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

                            console.log(`💾 About to save article to database...`);
                            const savedArticle = await newArticle.save();
                            console.log(`✅ Successfully saved article with ID: ${savedArticle._id}`);

                            totalNew++;
                            if (!sampleArticle) {
                                sampleArticle = newArticle;
                            }
                        } catch (saveError) {
                            console.error(`❌ Failed to save article "${title.slice(0, 50)}...":`, saveError);
                            console.error(`📊 Save error details:`, {
                                message: saveError.message,
                                code: saveError.code,
                                name: saveError.name,
                                stack: saveError.stack?.split('\n').slice(0, 3).join('\n')
                            });
                        }
                    } else {
                        console.warn(`⚠️ Skipping article due to missing data - Title: ${!!title}, Content: ${!!content}, URL: ${link}`);
                    }
                } catch (err) {
                    console.error(`Error on article ${link}:`, err.message);
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
            if (source.youtubeChannelId) {
                console.log(`Scraping YouTube Shorts (RSS-based) for ${source.name}`);
                const ytReels = await scrapeYouTubeShortsViaRSS(source);
                console.log(`  • ${ytReels.length} YouTube Shorts upserted via RSS`);
            }
            try {
                console.log(`Scraping full YouTube videos for ${source.name}`);
                const savedVideos = await scrapeYouTubeForSource(source._id, source.youtubeChannelId);
                console.log(`  • ${savedVideos.length} videos stored in Video collection`);
            } catch (err) {
                console.warn(`⚠️ Failed to scrape YouTube videos for ${source.name}:`, err.message);
            }

            console.log(`🔄 Updating lastScraped timestamp for source: ${source.name}`);
            source.lastScraped = new Date();
            await source.save();
            console.log(`✅ Source ${source.name} completed successfully`);
        } catch (err) {
            console.error(`❌ Failed to scrape ${source.url}:`, err.message);
            console.error(`📊 Source error details:`, {
                name: err.name,
                message: err.message,
                stack: err.stack?.split('\n').slice(0, 3).join('\n')
            });
        }
    }

    console.log(`📊 Scraping completed. Total new articles: ${totalNew}`);
    console.log(`📊 Sample article for notifications: ${sampleArticle ? 'Yes' : 'No'}`);

    if (totalNew > 0 && sampleArticle) {
        // Get users with push tokens and check their notification preferences
        const users = await User.find({ pushToken: { $exists: true, $ne: null } });

        // Filter users based on their notification settings
        const eligibleUsers = users.filter(user => {
            const settings = user.notificationSettings || {};

            // Check if user has news notifications enabled
            if (!settings.newsNotifications) return false;

            // Check if this is breaking news and user has breaking news enabled
            if (sampleArticle.category === 'headline' && !settings.breakingNews) return false;

            // For now, we'll send to all users with news notifications enabled
            // In the future, we can add more granular filtering based on followed sources
            return true;
        });

        const tokens = eligibleUsers.map(u => u.pushToken);

        if (tokens.length === 0) {
            console.log('No eligible users for notifications based on their preferences.');
            return;
        }

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

        console.log(`Summary notification sent to ${tokens.length} eligible users for ${totalNew} new articles.`);
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

                // Filter users based on their notification settings
                const eligibleUsers = users.filter(user => {
                    const settings = user.notificationSettings || {};
                    // Check if user has news notifications enabled
                    return settings.newsNotifications === true;
                });

                const tokens = eligibleUsers.map(u => u.pushToken);
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
                    console.log(`Lotto notification sent to ${tokens.length} eligible users for draw #${result.drawNumber}.`);
                }
            } else {
                console.warn('❌ Lotto result could not be scraped.');
            }
            console.log('>>> Lotto block finished');
        } catch (e) {
            console.error('❌ Lotto scraping error:', e);
        }
    }

    console.log(`🏁 scrapeAllSources completed`);
    console.log(`📊 Final Summary:`);
    console.log(`   - Total new articles saved: ${totalNew}`);
    console.log(`   - MongoDB connection state: ${mongoose.connection.readyState}`);
    console.log(`   - Sample article for notifications: ${sampleArticle ? `"${sampleArticle.title.slice(0, 30)}..."` : 'None'}`);
}

module.exports = scrapeAllSources;
