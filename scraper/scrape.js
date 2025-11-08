
// 🔧 Normalize and filter image URLs (strip css url(...), resolve to absolute, drop social SVGs, remove trackers)
function normalizeImages(imgs, baseUrl) {
    const EXCLUDE_FILES = new Set([
        'insta_icon_5.svg', 'facebook.svg', 'tiktok_icon.svg', 'x_logo_1.svg', 'whatsapp.svg', 'mail.svg'
    ]);
    function unwrapCssUrl(s) {
        if (!s) return s;
        const m = s.match(/^\s*url\((?:'|")?([^'")]+)(?:'|")?\)\s*$/i);
        return m ? m[1] : s;
    }
    function absolutize(u) {
        try {
            return new URL(u, baseUrl).toString();
        } catch {
            return u;
        }
    }
    return Array.from(new Set(
        (imgs || [])
            .map(unwrapCssUrl)
            .map(u => u && u.trim())
            .filter(Boolean)
            .filter(u => !/^data:/i.test(u))                        // drop data-uri
            .filter(src => {
                const url = src.toLowerCase();
                return !url.includes('1x1') &&
                    !url.includes('pixel') &&
                    !url.includes('tracker') &&
                    !url.includes('analytics');
            })
            .map(src => {
                // Replace low-res width params if present
                src = src.replace(/w=\d+/g, 'w=800');
                if (src.startsWith('//')) return 'https:' + src;
                if (src.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${src}`;
                return src;
            })
            .map(absolutize)
            .filter(u => {
                try {
                    const name = new URL(u).pathname.split('/').pop().toLowerCase();
                    if (EXCLUDE_FILES.has(name)) return false;
                    if (/\/wp-content\/themes\/whatson-grow\/images\//i.test(u) && name.endsWith('.svg')) return false;
                    return true;
                } catch { return false; }
            })
    ));
}

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
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');
const { scrapeYouTubeShortsViaRSS } = require('./youtubeRSSShortsScraper.js'); // Using RSS-based scraper
const { scrapeYouTubeForSource } = require('./youtubeScraper');
const mongoose = require('mongoose');

function cleanText(text) {
    if (!text) return '';
    return text.replace(/[\u0000-\u001F]+/g, '').trim();
}

function normalizeUrl(url) {
    if (!url) return '';
    try {
        const urlObj = new URL(url);
        // Remove common tracking parameters and fragments
        urlObj.search = '';
        urlObj.hash = '';
        // Ensure consistent trailing slash handling
        if (urlObj.pathname.endsWith('/') && urlObj.pathname.length > 1) {
            urlObj.pathname = urlObj.pathname.slice(0, -1);
        }
        return urlObj.toString();
    } catch (e) {
        // If URL parsing fails, return original URL
        return url;
    }
}

function isElementVisible($, element) {
    const $el = $(element);

    // Check inline styles for display: none or visibility: hidden
    const style = $el.attr('style') || '';
    if (style.includes('display:none') || style.includes('display: none') ||
        style.includes('visibility:hidden') || style.includes('visibility: hidden')) {
        return false;
    }

    // Check for common hidden classes
    const className = $el.attr('class') || '';
    const hiddenClasses = ['hidden', 'hide', 'invisible', 'sr-only', 'screen-reader-only', 'visually-hidden'];
    if (hiddenClasses.some(cls => className.includes(cls))) {
        return false;
    }

    // Check for common garbage element patterns
    const id = $el.attr('id') || '';
    const garbagePatterns = ['ad-', 'advertisement', 'banner', 'popup', 'modal', 'overlay', 'sidebar'];
    if (garbagePatterns.some(pattern => className.toLowerCase().includes(pattern) || id.toLowerCase().includes(pattern))) {
        return false;
    }

    return true;
}

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
    let sources = await Source.find({ status: { $ne: 'blocked' } });
    console.log(`📊 Found ${sources.length} total sources (excluding blocked)`);

    // Filter out suspended and only keep active sources
    sources = sources.filter(s => s.status === 'active' || !s.status); // Include sources without status field (backwards compatibility)
    console.log(`📊 Filtered to ${sources.length} active sources`);

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
            let usedPuppeteer = false;

            // Use Puppeteer for sources with known bot protection or specific keywords
            const needsPuppeteer = source.name.toLowerCase().includes('gulfi news') ||
                source.name.toLowerCase().includes('timeout') ||
                source.name.toLowerCase().includes('bot-protection') ||
                source.name.toLowerCase().includes('spa') ||
                source.name.toLowerCase().includes('javascript') ||
                source.name.toLowerCase().includes('alnassr') ||
                source.name.toLowerCase().includes('al nassr') ||
                source.name.toLowerCase().includes('doha') ||
                source.name.toLowerCase().includes('dohanews');

            if (needsPuppeteer) {
                console.log(`🤖 Using Puppeteer for ${source.name} (bot protection/special handling)`);
                try {
                    ({ html } = await fetchWithPuppeteer(source.url));
                    usedPuppeteer = true;
                } catch (puppeteerError) {
                    console.error(`❌ Puppeteer failed for ${source.name}:`, puppeteerError.message);
                    console.log(`⚠️ Skipping ${source.name} due to Puppeteer Chrome installation issues`);
                    continue; // Skip this source and move to the next
                }
            } else {
                // Try regular request first, fallback to Puppeteer if 403
                try {
                    const response = await axios.get(source.url, {
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'DNT': '1',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                        }
                    });
                    html = response.data;

                    // Check if this might be a SPA that needs JavaScript rendering
                    const bodyContent = html.toLowerCase();
                    const isSPA = bodyContent.includes('<div id="app">') ||
                        bodyContent.includes('<div id="root">') ||
                        bodyContent.includes('vue') ||
                        bodyContent.includes('react') ||
                        bodyContent.includes('angular') ||
                        bodyContent.includes('chunk-vendors') ||
                        bodyContent.includes('app.js') ||
                        bodyContent.includes('main.js') ||
                        bodyContent.includes('__nuxt') ||
                        bodyContent.includes('next.js');

                    if (isSPA) {
                        console.log(`🔍 SPA detected for ${source.name}, switching to Puppeteer for JavaScript rendering...`);
                        try {
                            ({ html } = await fetchWithPuppeteer(source.url));
                            usedPuppeteer = true;
                            console.log(`✅ Puppeteer successfully rendered SPA content for ${source.name}`);
                        } catch (puppeteerError) {
                            console.error(`❌ Puppeteer failed for SPA ${source.name}:`, puppeteerError.message);
                            console.log(`⚠️ Falling back to basic HTML for ${source.name} (content may be incomplete)`);
                            // Continue with the original HTML
                        }
                    }
                } catch (fetchError) {
                    if (fetchError.response && fetchError.response.status === 403) {
                        console.log(`🔒 Bot protection detected for ${source.name}, switching to Puppeteer...`);
                        try {
                            ({ html } = await fetchWithPuppeteer(source.url));
                            usedPuppeteer = true;
                            console.log(`✅ Puppeteer successfully bypassed bot protection for ${source.name}`);
                        } catch (puppeteerError) {
                            console.error(`❌ Puppeteer failed for bot-protected ${source.name}:`, puppeteerError.message);
                            console.log(`⚠️ Skipping ${source.name} - both standard fetch and Puppeteer failed`);
                            continue; // Skip this source instead of throwing
                        }
                    } else {
                        throw fetchError;
                    }
                }
            }

            const $ = cheerio.load(html);
            const listSel = source.listSelector || 'div[class*="m04n-"]';
            const linkSel = source.linkSelector || 'a';
            const links = [];
            $(listSel).each((_, el) => {
                const href = $(el).find(linkSel).attr('href');
                if (href && href !== ':' && href !== '') {
                    let url;
                    if (href.startsWith('http')) {
                        url = href;
                    } else {
                        // Get base URL for link construction
                        let baseUrl = source.baseUrl;
                        if (!baseUrl) {
                            try {
                                // Extract domain from source URL if baseUrl is not set
                                const urlObj = new URL(source.url);
                                baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
                            } catch {
                                baseUrl = source.url.replace(/\/$/, '');
                            }
                        } else {
                            baseUrl = baseUrl.replace(/\/$/, '');
                        }
                        url = href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
                    }
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
                    const normalizedLink = normalizeUrl(link);
                    console.log(`🔍 Checking if article exists: ${normalizedLink}`);

                    // Check for exact URL match and normalized URL match
                    const exists = await Article.findOne({
                        $or: [
                            { url: link },
                            { url: normalizedLink }
                        ]
                    });

                    if (exists) {
                        console.log(`⏭️ Article already exists, skipping: ${normalizedLink}`);
                        continue;
                    }
                    console.log(`🆕 New article found, processing: ${normalizedLink}`);

                    let pageHtml;
                    if (usedPuppeteer || source.name.toLowerCase().includes('gulfi news') || source.name.toLowerCase().includes('timeout')) {
                        const { browser, page } = await fetchWithPuppeteer(link, { returnPage: true });

                        try {
                            // 🛂 Try to click the consent button if present
                            const consentSelector = 'button.fc-button.fc-cta-consent.fc-primary-button';
                            const consentButton = await page.$(consentSelector);
                            if (consentButton) {
                                console.log('🛂 Clicking consent button...');
                                await page.click(consentSelector);
                                await page.waitForTimeout(800); // allow modal to disappear
                            }

                            pageHtml = await page.content();
                            await browser.close();
                        } catch (err) {
                            console.warn('⚠️ Error handling consent popup:', err.message);
                            await browser.close();
                            // Fallback to regular axios if Puppeteer fails
                            try {
                                pageHtml = (await axios.get(link, {
                                    timeout: 10000,
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                                        "Accept-Language": "en-US,en;q=0.9",
                                        "Referer": "https://www.google.com/",
                                        "Cache-Control": "no-cache",
                                    }
                                })).data;
                            } catch (fallbackError) {
                                console.warn(`⚠️ Failed to fetch article ${link}:`, fallbackError.message);
                                continue; // Skip this article
                            }
                        }
                    } else {
                        try {
                            pageHtml = (await axios.get(link, {
                                timeout: 10000,
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                                }
                            })).data;
                        } catch (articleError) {
                            if (articleError.response && articleError.response.status === 403) {
                                console.log(`🔒 Bot protection detected for article ${link}, switching to Puppeteer...`);
                                try {
                                    const { browser, page } = await fetchWithPuppeteer(link, { returnPage: true });
                                    pageHtml = await page.content();
                                    await browser.close();
                                } catch (puppeteerError) {
                                    console.warn(`⚠️ Puppeteer fallback failed for ${link}:`, puppeteerError.message);
                                    continue; // Skip this article
                                }
                            } else {
                                console.warn(`⚠️ Failed to fetch article ${link}:`, articleError.message);
                                continue; // Skip this article
                            }
                        }
                    }
                    const $$ = cheerio.load(pageHtml);

                    console.log(`📝 Extracting content using selectors - Title: "${source.titleSelector || '.ORiM7'}", Content: "${source.contentSelector || '.story-element.story-element-text p'}"`);

                    // Extract title and content - filter out hidden elements
                    const title = cleanText($$(source.titleSelector || '.ORiM7')
                        .filter((_, el) => isElementVisible($$, el))
                        .first()
                        .text());

                    // 📸 IMPROVED: Process content elements in order, preserving embed positions inline
                    // Also capture h2, h3, ul, ol for rich content structure
                    let contentParts = [];
                    let embedCount = 0;
                    let headingCount = 0;
                    let listCount = 0;

                    try {
                        // CRITICAL FIX: Expand selector to include headings and lists, not just paragraphs
                        // This ensures we capture h2, h3, ul, ol elements for markdown formatting
                        const expandedSelector = source.contentSelector
                            ? `${source.contentSelector}, ${source.contentSelector.replace(/\s+p$/, '')} h2, ${source.contentSelector.replace(/\s+p$/, '')} h3, ${source.contentSelector.replace(/\s+p$/, '')} ul, ${source.contentSelector.replace(/\s+p$/, '')} ol`
                            : '.story-element.story-element-text p, .story-element.story-element-text h2, .story-element.story-element-text h3, .story-element.story-element-text ul, .story-element.story-element-text ol';

                        $$(expandedSelector).each((_, el) => {
                            // Skip hidden elements
                            if (!isElementVisible($$, el)) return;

                            const $el = $$(el);

                            // Check if this is an Instagram embed (blockquote or iframe)
                            if ($el.is('blockquote.instagram-media') || $el.is('iframe.instagram-media') || $el.is('iframe.instagram-media-rendered')) {
                                const embedHtml = $$.html(el);
                                if (embedHtml) {
                                    contentParts.push(`[INSTAGRAM_EMBED]${embedHtml}[/INSTAGRAM_EMBED]`);
                                    embedCount++;
                                    console.log(`📸 Found Instagram embed #${embedCount} (inline position preserved)`);
                                }
                                return; // Skip to next element
                            }

                            // Check if this is a Twitter embed
                            if ($el.is('blockquote.twitter-tweet') || ($el.is('iframe') && ($el.attr('src') || '').includes('twitter.com'))) {
                                const embedHtml = $$.html(el);
                                if (embedHtml) {
                                    contentParts.push(`[TWITTER_EMBED]${embedHtml}[/TWITTER_EMBED]`);
                                    embedCount++;
                                    console.log(`� Found Twitter embed #${embedCount} (inline position preserved)`);
                                }
                                return; // Skip to next element
                            }

                            // Skip elements inside blockquotes (they're part of the embed)
                            if ($el.closest('blockquote.instagram-media').length > 0 ||
                                $el.closest('blockquote.twitter-tweet').length > 0) {
                                return;
                            }

                            // Skip other iframes
                            if ($el.is('iframe')) return;

                            const tagName = el.name;

                            // Handle h2 headings
                            if (tagName === 'h2') {
                                const heading = $el.text().trim();
                                if (heading.length > 0) {
                                    contentParts.push(`\n## ${heading}\n`);
                                    headingCount++;
                                    console.log(`📝 Found h2 heading: "${heading.substring(0, 50)}..."`);
                                }
                                return;
                            }

                            // Handle h3 headings
                            if (tagName === 'h3') {
                                const heading = $el.text().trim();
                                if (heading.length > 0) {
                                    contentParts.push(`\n### ${heading}\n`);
                                    headingCount++;
                                    console.log(`📝 Found h3 heading: "${heading.substring(0, 50)}..."`);
                                }
                                return;
                            }

                            // Handle unordered lists (ul) - Use markdown format
                            if (tagName === 'ul') {
                                const listItems = [];
                                $el.find('li').each((_, li) => {
                                    const itemText = $$(li).text().trim();
                                    if (itemText.length > 0) {
                                        listItems.push(`- ${itemText}`);
                                    }
                                });
                                if (listItems.length > 0) {
                                    contentParts.push('\n' + listItems.join('\n') + '\n');
                                    listCount++;
                                    console.log(`📋 Found unordered list with ${listItems.length} items`);
                                }
                                return;
                            }

                            // Handle ordered lists (ol)
                            if (tagName === 'ol') {
                                const listItems = [];
                                $el.find('li').each((i, li) => {
                                    const itemText = $$(li).text().trim();
                                    if (itemText.length > 0) {
                                        listItems.push(`${i + 1}. ${itemText}`);
                                    }
                                });
                                if (listItems.length > 0) {
                                    contentParts.push('\n' + listItems.join('\n') + '\n');
                                    listCount++;
                                    console.log(`🔢 Found ordered list with ${listItems.length} items`);
                                }
                                return;
                            }

                            // Extract text content for paragraphs and other elements
                            const text = $el.text().trim();
                            if (text.length > 10) {
                                contentParts.push(text);
                            }
                        });

                        if (embedCount > 0) {
                            console.log(`✅ Total embeds found: ${embedCount} (preserved inline in content)`);
                        }
                        if (headingCount > 0) {
                            console.log(`✅ Total headings found: ${headingCount} (h2/h3)`);
                        }
                        if (listCount > 0) {
                            console.log(`✅ Total lists found: ${listCount} (ul/ol)`);
                        }

                        // Log markdown format detection
                        if (headingCount > 0 || listCount > 0) {
                            console.log(`📝 Content will be saved as MARKDOWN format (headings: ${headingCount}, lists: ${listCount})`);
                        } else {
                            console.log(`📄 Content will be saved as TEXT format (no structured elements found)`);
                        }
                    } catch (embedError) {
                        console.warn('⚠️ Error processing content with embeds/structure:', embedError.message);
                    }

                    // Join all parts (text + embeds + headings + lists) with double newlines
                    let content = cleanText(contentParts.join('\n\n'));

                    console.log(`📊 Extracted - Title length: ${title.length}, Content length: ${content.length}`);

                    // Additional duplicate check by title to catch same articles with different URLs
                    if (title && title.length > 5) {
                        const titleExists = await Article.findOne({
                            title: title,
                            sourceId: source._id
                        });
                        if (titleExists) {
                            console.log(`⏭️ Article with same title already exists, skipping: "${title.slice(0, 50)}..."`);
                            continue;
                        }
                    }

                    // Extract images - filter out hidden images
                    // Enhanced image extraction: supports <img>, data-bg, and CSS background-image
                    function extractBgUrl(val) {
                        if (!val) return null;
                        // Handles values like: url(https://...) or url('https://...') or url("https://...")
                        const m = /url\((?:'|\")?([^\)'\"]+)(?:'|\")?\)/i.exec(val);
                        return m ? m[1] : null;
                    }

                    let images = [];
                    const imageNodes = $$(source.imageSelector || 'img')
                        .filter((_, el) => isElementVisible($$, el));

                    imageNodes.each((_, el) => {
                        const $el = $$(el);
                        let src = null;

                        if ($el.is('img')) {
                            src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src');
                        } else {
                            // Support containers with background images
                            src = $el.attr('data-bg') || extractBgUrl($el.attr('style'));
                        }

                        if (src) images.push(src);
                    });

                    // Use the normalizeImages function for proper cleanup
                    images = normalizeImages(images, source.baseUrl || source.url);

                    // Try to pull hero background from .page-header when no body images found
                    if (images.length === 0) {
                        const style = $$('.page-header').attr('style') || '';
                        const m = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
                        if (m) {
                            images.unshift(m[1]);
                            console.log(`📸 Found hero background image: ${m[1]}`);
                        }
                    }

                    // Fallback to Open Graph / Twitter meta
                    if (images.length === 0) {
                        const og = $$('meta[property="og:image"]').attr('content') || $$('meta[name="twitter:image"]').attr('content');
                        if (og) {
                            const fallbackImages = [og];
                            images = normalizeImages(fallbackImages, source.baseUrl || source.url);
                            console.log(`📸 Using Open Graph/Twitter image: ${og}`);
                        }
                    }
                    let embedding = [];
                    let embedding_pca = null;
                    try {
                        const embedInput = `${title}\n\n${content?.slice(0, 512) || ''}`;
                        embedding = await getDeepSeekEmbedding(embedInput);
                        console.log('✅ Got embedding for:', title);

                        // Generate PCA embedding for new article
                        if (embedding && embedding.length === 1536) {
                            embedding_pca = await convertToPCAEmbedding(embedding);
                            if (embedding_pca) {
                                console.log('✅ Generated PCA embedding (128D) for:', title);
                            } else {
                                console.warn('⚠️ Failed to generate PCA embedding for:', title);
                            }
                        }
                    } catch (err) {
                        console.warn('❌ Embedding error for article:', title, err.message);
                    }

                    // Save article if valid - more strict validation
                    if (title && content && title.length > 5 && content.length > 50) {
                        console.log(`📝 Attempting to save article: "${title.slice(0, 50)}..." for source: ${source.name}`);
                        console.log(`📋 Article details - URL: ${normalizedLink}, Category: ${source.category}, Language: ${source.language || "english"}`);
                        console.log(`🖼️ Images found: ${images.length}`);
                        console.log(`🔗 Embedding length: ${embedding.length}`);
                        console.log(`🔗 PCA embedding length: ${embedding_pca ? embedding_pca.length : 'N/A'}`);

                        try {
                            const articleData = {
                                title,
                                content,
                                contentFormat: 'markdown', // NEW: Indicate content is in markdown format
                                url: normalizedLink, // Use normalized URL for consistency
                                sourceId: source._id,
                                category: source.category,
                                publishedAt: new Date(),
                                language: source.language || "english",
                                embedding
                            };

                            // Add PCA embedding if available
                            if (embedding_pca && embedding_pca.length === 128) {
                                articleData.embedding_pca = embedding_pca;
                            }

                            const newArticle = new Article(articleData);

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
                        console.warn(`⚠️ Skipping article due to insufficient content - Title: ${!!title} (${title?.length || 0} chars), Content: ${!!content} (${content?.length || 0} chars), URL: ${normalizedLink}`);
                        if (title && title.length <= 5) console.warn(`  - Title too short: "${title}"`);
                        if (content && content.length <= 50) console.warn(`  - Content too short: "${content.slice(0, 50)}..."`);
                    }
                } catch (err) {
                    console.error(`Error on article ${normalizedLink}:`, err.message);
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
            // if (source.youtubeChannelId) {
            //     console.log(`Scraping YouTube Shorts (RSS-based) for ${source.name}`);
            //     const ytReels = await scrapeYouTubeShortsViaRSS(source);
            //     console.log(`  • ${ytReels.length} YouTube Shorts upserted via RSS`);
            // }
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
