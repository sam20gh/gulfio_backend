const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const mongoose = require('mongoose');
const Source = require('../models/Source');
const { fetchWithPuppeteer } = require('./fetchWithPuppeteer');

// Utility functions from the main scraper
function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function isElementVisible($, el) {
    const $el = $(el);
    const style = $el.attr('style') || '';
    if (style.includes('display: none') || style.includes('display:none') ||
        style.includes('visibility: hidden') || style.includes('visibility:hidden')) {
        return false;
    }

    const className = $el.attr('class') || '';
    const hiddenClasses = ['hidden', 'hide', 'invisible', 'sr-only', 'screen-reader-only', 'visually-hidden'];
    if (hiddenClasses.some(cls => className.includes(cls))) {
        return false;
    }

    const id = $el.attr('id') || '';
    const garbagePatterns = ['ad-', 'advertisement', 'banner', 'popup', 'modal', 'overlay', 'sidebar'];
    if (garbagePatterns.some(pattern => className.toLowerCase().includes(pattern) || id.toLowerCase().includes(pattern))) {
        return false;
    }

    return true;
}

// 🔧 Clean Next.js image proxy URLs - extract the real image URL
function cleanImageUrl(url) {
    if (!url) return null;

    // If Next.js proxy URL → extract & decode the real image URL
    if (url.includes('/_next/image')) {
        const real = url.split('url=')[1]?.split('&')[0];
        return real ? decodeURIComponent(real) : null;
    }

    return url;
}

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
            .map(cleanImageUrl)                                     // Handle Next.js /_next/image proxy URLs
            .map(u => u && u.trim())
            .filter(Boolean)
            .filter(u => !/^data:/i.test(u))
            .filter(src => {
                const url = src.toLowerCase();
                return !url.includes('1x1') &&
                    !url.includes('pixel') &&
                    !url.includes('tracker') &&
                    !url.includes('analytics');
            })
            .map(src => {
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

// ───────────────────────────── Khaleej Times adapter ─────────────────────────────
// Mirrors the adapter in scrape.js so test results match production. KT's generic
// h2/h3 + "p" + "img" selectors over-match (section links, lazy SVG placeholders,
// every paragraph on the page); this pins the real card / body / image structure.
function isKhaleejTimes(source) {
    const hay = `${source.name || ''} ${source.url || ''} ${source.baseUrl || ''}`.toLowerCase();
    return hay.includes('khaleejtimes') || hay.includes('khaleej times');
}

// KT story URLs end in a long hyphenated slug; section index pages (/business,
// /business/markets) have a short single-word final segment and are skipped.
function isKhaleejArticleUrl(url) {
    try {
        const { pathname } = new URL(url);
        const segs = pathname.split('/').filter(Boolean);
        if (segs.length < 2) return false;
        const slug = segs[segs.length - 1];
        return slug.includes('-') && slug.length > 15;
    } catch {
        return false;
    }
}

// Top-level section of a path, e.g. "/business/markets" → "business".
function topLevelSection(urlOrPath) {
    try {
        const pathname = urlOrPath.startsWith('http') ? new URL(urlOrPath).pathname : urlOrPath;
        return pathname.split('/').filter(Boolean)[0] || null;
    } catch {
        return null;
    }
}

function resolveHref(href, source) {
    if (!href || href === ':' || href === '') return null;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('http')) return href;
    let baseUrl = source.baseUrl;
    if (!baseUrl) {
        try {
            const urlObj = new URL(source.url);
            baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
        } catch {
            baseUrl = source.url.replace(/\/$/, '');
        }
    } else {
        baseUrl = baseUrl.replace(/\/$/, '');
    }
    return href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
}

// Collect KT story links from the listing card containers, keep only real story URLs,
// and pin them to the source's own section. Falls back to all anchors if markup changes.
function parseKhaleejLinks($, source) {
    const section = topLevelSection(source.url);
    const collect = (selector) => {
        const out = [];
        $(selector).each((_, el) => {
            const url = resolveHref($(el).attr('href'), source);
            if (!url || !isKhaleejArticleUrl(url)) return;
            if (section && topLevelSection(url) !== section) return;
            if (!out.includes(url)) out.push(url);
        });
        return out;
    };

    const CARD_SELECTOR =
        '.card-article-list-item a[href], .subsection-listing-article-box a[href], .post-title-rows a[href]';
    let links = collect(CARD_SELECTOR);
    if (links.length === 0) {
        console.log(`🔎 KT: no links via card containers for ${source.name}, falling back to all anchors`);
        links = collect('a[href]');
    }
    return links;
}

/**
 * Test RSS feed parsing for a single RSS source
 * @param {Object} source - Source document from MongoDB
 * @returns {Object} Test results including extracted RSS data and any errors
 */
async function testRSSSource(source) {
    console.log(`📡 Testing RSS feed: ${source.name}`);
    console.log(`🔗 RSS URL: ${source.url}`);

    const testResults = {
        source: {
            name: source.name,
            url: source.url,
            type: 'rss'
        },
        steps: [],
        articles: [],
        errors: [],
        success: false
    };

    try {
        // Step 1: Fetch RSS feed
        testResults.steps.push('Fetching RSS feed...');
        console.log('📥 Fetching RSS feed...');

        const response = await axios.get(source.url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; RSS-Reader/1.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml'
            }
        });

        testResults.steps.push(`✅ RSS feed fetched (${response.data.length} bytes)`);
        console.log(`✅ RSS feed fetched (${response.data.length} bytes)`);

        // Step 2: Parse XML
        testResults.steps.push('Parsing XML content...');
        console.log('🔍 Parsing XML content...');

        const parser = new xml2js.Parser({
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: true
        });

        const result = await parser.parseStringPromise(response.data);

        // Support both RSS and Atom feeds
        const feedType = result.rss ? 'RSS' : result.feed ? 'Atom' : 'Unknown';
        testResults.steps.push(`✅ ${feedType} feed parsed successfully`);
        console.log(`✅ ${feedType} feed parsed successfully`);

        let items = [];
        if (result.rss && result.rss.channel && result.rss.channel.item) {
            items = Array.isArray(result.rss.channel.item) ? result.rss.channel.item : [result.rss.channel.item];
        } else if (result.feed && result.feed.entry) {
            items = Array.isArray(result.feed.entry) ? result.feed.entry : [result.feed.entry];
        }

        testResults.steps.push(`✅ Found ${items.length} items in feed`);
        console.log(`✅ Found ${items.length} items in feed`);

        if (items.length === 0) {
            testResults.errors.push('No items found in RSS feed');
            testResults.steps.push('❌ No items found in feed');
            return testResults;
        }

        // Step 3: Process first 3 items
        const testItems = items.slice(0, 3);
        testResults.steps.push(`Processing first ${testItems.length} items...`);

        for (let i = 0; i < testItems.length; i++) {
            const item = testItems[i];
            console.log(`🧪 Testing RSS item ${i + 1}`);

            try {
                // Extract title
                let title = '';
                if (feedType === 'RSS') {
                    title = item.title || '';
                } else if (feedType === 'Atom') {
                    title = typeof item.title === 'object' ? item.title._ || item.title : item.title || '';
                }
                title = title.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();

                // Extract content
                let content = '';
                if (feedType === 'RSS') {
                    content = item.description || item['content:encoded'] || '';
                } else if (feedType === 'Atom') {
                    content = item.content ? (typeof item.content === 'object' ? item.content._ || item.content : item.content) : item.summary || '';
                }
                content = content.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1');

                // Strip HTML tags from content for text length calculation
                const textContent = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

                // Extract URL
                let url = '';
                if (feedType === 'RSS') {
                    url = item.link || item.guid || '';
                } else if (feedType === 'Atom') {
                    url = typeof item.link === 'object' ? item.link.href : item.link || item.id || '';
                }

                // Extract publication date
                let pubDate = '';
                if (feedType === 'RSS') {
                    pubDate = item.pubDate || item['dc:date'] || '';
                } else if (feedType === 'Atom') {
                    pubDate = item.published || item.updated || '';
                }

                // Extract images
                let images = [];
                if (feedType === 'RSS') {
                    // Check for media:content, media:thumbnail, enclosure
                    if (item['media:content']) {
                        const mediaContent = Array.isArray(item['media:content']) ? item['media:content'] : [item['media:content']];
                        images = images.concat(mediaContent.filter(m => m.url && m.medium === 'image').map(m => m.url));
                    }
                    if (item['media:thumbnail']) {
                        const mediaThumbnail = Array.isArray(item['media:thumbnail']) ? item['media:thumbnail'] : [item['media:thumbnail']];
                        images = images.concat(mediaThumbnail.filter(m => m.url).map(m => m.url));
                    }
                    if (item.enclosure && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
                        images.push(item.enclosure.url);
                    }
                }

                // Look for images in content
                const imgRegex = /<img[^>]+src="([^"]+)"/gi;
                let match;
                while ((match = imgRegex.exec(content)) !== null) {
                    images.push(match[1]);
                }

                // Remove duplicates and clean images
                const baseUrl = new URL(source.url).origin;
                images = normalizeImages([...new Set(images)], baseUrl);

                const articleData = {
                    url: url || 'No URL found',
                    title: title || 'No title found',
                    content: textContent || 'No content found',
                    htmlContent: content,
                    images: images,
                    pubDate: pubDate,
                    contentLength: textContent.length,
                    titleLength: title.length,
                    imageCount: images.length
                };

                testResults.articles.push(articleData);
                console.log(`📊 RSS Item ${i + 1} - Title: "${title.slice(0, 50)}...", Content: ${textContent.length} chars, Images: ${images.length}`);

            } catch (itemError) {
                const errorMsg = `Error processing RSS item ${i + 1}: ${itemError.message}`;
                testResults.errors.push(errorMsg);
                console.error(`❌ ${errorMsg}`);
            }
        }

        testResults.steps.push(`✅ Completed processing ${testResults.articles.length} RSS items`);
        testResults.success = testResults.articles.length > 0 && testResults.articles.some(a => a.title !== 'No title found');

        console.log(`🏁 RSS test completed for ${source.name}`);
        console.log(`📊 Results: ${testResults.articles.length} items processed, ${testResults.errors.length} errors`);

        return testResults;

    } catch (error) {
        console.error(`❌ RSS test failed for ${source.name}:`, error);
        testResults.errors.push(`RSS parsing failed: ${error.message}`);
        testResults.steps.push('❌ RSS test failed during processing');
        return testResults;
    }
}

/**
 * Test scraping functionality for a single source
 * @param {string} sourceId - MongoDB ObjectId of the source to test
 * @returns {Object} Test results including extracted data and any errors
 */
async function testSingleSource(sourceId) {
    console.log(`🧪 Starting test scrape for source ID: ${sourceId}`);

    // Ensure MongoDB connection
    if (mongoose.connection.readyState !== 1) {
        console.log('⚠️ MongoDB not connected. Connecting now...');
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
            console.log('✅ MongoDB connected for test.');
        } catch (connectError) {
            console.error('❌ MongoDB connection failed:', connectError);
            throw connectError;
        }
    }

    try {
        // Find the source
        const source = await Source.findById(sourceId);
        if (!source) {
            throw new Error(`Source with ID ${sourceId} not found`);
        }

        console.log(`🎯 Testing source: ${source.name}`);
        console.log(`🔗 URL: ${source.url}`);
        console.log(`📊 Type: ${source.type || 'html'}`);

        // Check source status and warn if not active
        if (source.status && source.status !== 'active') {
            console.log(`⚠️ WARNING: Source status is "${source.status}" - this source would be skipped during normal scraping`);
        }

        // Check if this is an RSS source
        if (source.type === 'rss') {
            console.log('📡 RSS source detected, using RSS testing function...');
            return await testRSSSource(source);
        }

        console.log(`📊 Selectors - List: "${source.listSelector}", Link: "${source.linkSelector}", Title: "${source.titleSelector}", Content: "${source.contentSelector}"`);

        const testResults = {
            source: {
                name: source.name,
                url: source.url,
                type: source.type || 'html',
                status: source.status,
                selectors: {
                    listSelector: source.listSelector,
                    linkSelector: source.linkSelector,
                    titleSelector: source.titleSelector,
                    contentSelector: source.contentSelector,
                    imageSelector: source.imageSelector
                }
            },
            steps: [],
            articles: [],
            errors: [],
            success: false
        };

        // Add status warning to test results if source is not active
        if (source.status && source.status !== 'active') {
            testResults.steps.push(`⚠️ WARNING: Source status is "${source.status}" - would be skipped during normal scraping`);
        }

        // Step 1: Fetch main page
        testResults.steps.push('Fetching main page...');
        console.log('📥 Fetching main page...');

        let response;
        try {
            response = await axios.get(source.url, {
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
        } catch (fetchError) {
            if (fetchError.response) {
                const statusCode = fetchError.response.status;
                const statusText = fetchError.response.statusText;
                const errorMsg = `HTTP ${statusCode} ${statusText} - Website may have bot protection or be temporarily unavailable`;
                testResults.errors.push(errorMsg);
                testResults.steps.push(`❌ Failed to fetch main page: ${errorMsg}`);

                if (statusCode === 403) {
                    testResults.errors.push('403 Forbidden - This website likely has bot protection (CloudFront, DataDome, etc.)');
                    testResults.steps.push('💡 Suggestion: This source may need Puppeteer/headless browser to bypass bot protection');
                }

                return testResults;
            } else {
                throw fetchError; // Re-throw for network errors
            }
        }

        let $ = cheerio.load(response.data); testResults.steps.push(`✅ Main page fetched (${response.data.length} bytes)`);
        console.log(`✅ Main page fetched (${response.data.length} bytes)`);

        // Step 2: Extract article links
        testResults.steps.push('Extracting article links...');
        console.log(`🔍 Extracting links with selector: "${source.listSelector}"`);

        const isKT = isKhaleejTimes(source);
        let links = [];
        if (isKT) {
            console.log('📰 Khaleej Times detected — using KT link adapter (card containers + section scope)');
            links = parseKhaleejLinks($, source);
        } else {
            $(source.listSelector).each((_, element) => {
                const $elem = $(element);
                const linkHref = $elem.find(source.linkSelector).attr('href') || $elem.attr('href');
                if (linkHref) {
                    let fullLink;
                    if (linkHref.startsWith('http')) {
                        fullLink = linkHref;
                    } else {
                        // Extract domain from source URL for proper base URL
                        const baseUrl = source.baseUrl || (() => {
                            try {
                                const urlObj = new URL(source.url);
                                return `${urlObj.protocol}//${urlObj.hostname}`;
                            } catch {
                                return source.url.replace(/\/$/, '');
                            }
                        })();
                        fullLink = linkHref.startsWith('/') ? `${baseUrl}${linkHref}` : `${baseUrl}/${linkHref}`;
                    }
                    if (fullLink && !links.includes(fullLink)) {
                        links.push(fullLink);
                    }
                }
            });
        }

        testResults.steps.push(`✅ Found ${links.length} article links`);
        console.log(`✅ Found ${links.length} article links`);

        if (links.length === 0) {
            // Check if this might be a Single Page Application (SPA)
            const bodyContent = response.data.toLowerCase();
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
                testResults.steps.push('🔍 SPA detected, switching to Puppeteer for JavaScript rendering...');
                console.log('🔍 SPA detected, switching to Puppeteer for JavaScript rendering...');

                try {
                    const fetchWithPuppeteer = require('./fetchWithPuppeteer');
                    const puppeteerResult = await fetchWithPuppeteer(source.url);
                    const puppeteerHtml = puppeteerResult.html;
                    $ = cheerio.load(puppeteerHtml);

                    testResults.steps.push('✅ Puppeteer successfully rendered SPA content');
                    console.log('✅ Puppeteer successfully rendered SPA content');

                    // Re-extract links with Puppeteer-rendered content
                    if (isKT) {
                        parseKhaleejLinks($, source).forEach(l => {
                            if (!links.includes(l)) links.push(l);
                        });
                    } else {
                        $(source.listSelector).each((_, element) => {
                            const $elem = $(element);
                            const linkHref = $elem.find(source.linkSelector).attr('href') || $elem.attr('href');
                            if (linkHref) {
                                const fullLink = linkHref.startsWith('http') ? linkHref : `${source.baseUrl || source.url}${linkHref}`;
                                if (fullLink && !links.includes(fullLink)) {
                                    links.push(fullLink);
                                }
                            }
                        });
                    }

                    testResults.steps.push(`✅ Re-extraction found ${links.length} article links with Puppeteer`);
                    console.log(`✅ Re-extraction found ${links.length} article links`);

                } catch (puppeteerError) {
                    testResults.errors.push(`❌ Puppeteer failed: ${puppeteerError.message}`);
                    testResults.steps.push('❌ Puppeteer rendering failed');
                    console.error('❌ Puppeteer failed:', puppeteerError.message);
                }
            }

            if (links.length === 0) {
                if (isSPA) {
                    testResults.errors.push('No article links found even with Puppeteer - check selectors');
                } else {
                    testResults.errors.push('No article links found. Check listSelector and linkSelector.');
                    testResults.steps.push('💡 Verify selectors exist on the target page');
                }
                testResults.steps.push('❌ No links found - check selectors or site type');
                return testResults;
            }
        }

        // Step 3: Test first 3 articles
        const testLinks = links.slice(0, 3);
        testResults.steps.push(`Testing first ${testLinks.length} articles...`);

        for (let i = 0; i < testLinks.length; i++) {
            const link = testLinks[i];
            console.log(`🧪 Testing article ${i + 1}: ${link}`);

            try {
                let pageHtml;
                // Check if this source needs Puppeteer (same logic as main scraper)
                const needsPuppeteer = source.name.toLowerCase().includes('gulfi news') ||
                    source.name.toLowerCase().includes('timeout') ||
                    source.name.toLowerCase().includes('bot-protection') ||
                    source.name.toLowerCase().includes('spa') ||
                    source.name.toLowerCase().includes('javascript') ||
                    source.name.toLowerCase().includes('alnassr') ||
                    source.name.toLowerCase().includes('al nassr') ||
                    source.name.toLowerCase().includes('doha') ||
                    source.name.toLowerCase().includes('ajman media') ||
                    source.name.toLowerCase().includes('dohanews');

                if (needsPuppeteer) {
                    const { browser, page } = await fetchWithPuppeteer(link, { returnPage: true });
                    try {
                        const consentSelector = 'button.fc-button.fc-cta-consent.fc-primary-button';
                        const consentButton = await page.$(consentSelector);
                        if (consentButton) {
                            console.log('🛂 Clicking consent button...');
                            await page.click(consentSelector);
                            await page.waitForTimeout(800);
                        }
                        pageHtml = await page.content();
                        await browser.close();
                    } catch (err) {
                        console.warn('⚠️ Error handling consent popup:', err.message);
                        await browser.close();
                        pageHtml = (await axios.get(link, {
                            timeout: 10000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                            }
                        })).data;
                    }
                } else {
                    try {
                        pageHtml = (await axios.get(link, {
                            timeout: 10000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                            }
                        })).data;
                    } catch (articleFetchError) {
                        if (articleFetchError.response && articleFetchError.response.status === 403) {
                            testResults.errors.push(`Article ${i + 1}: 403 Forbidden - Bot protection detected`);
                            console.log(`⚠️ Article ${i + 1}: Bot protection detected, skipping...`);
                            continue;
                        } else {
                            throw articleFetchError;
                        }
                    }
                }

                const $$ = cheerio.load(pageHtml);

                // Extract title
                const title = cleanText($$(source.titleSelector || '.ORiM7')
                    .filter((_, el) => isElementVisible($$, el))
                    .first()
                    .text());

                // Extract content (KT body lives in .article-center-wrap-nf .inner.innermixmatch;
                // the related list and preloaded next-article sit outside that container)
                const contentSelector = isKT
                    ? '.article-center-wrap-nf .inner.innermixmatch p'
                    : (source.contentSelector || '.story-element.story-element-text p');
                const content = cleanText(
                    $$(contentSelector)
                        .filter((_, p) => isElementVisible($$, p))
                        .map((_, p) => $$(p).text().trim())
                        .get()
                        .filter(text => text.length > 10)
                        .join('\n\n')
                );

                // Extract images. KT inline <img> are lazy SVG placeholders (data: URIs);
                // the real lead image is in .img-wrap, with og:image as fallback.
                let images = [];
                const imageSelector = isKT ? '.article-center-wrap-nf .img-wrap img' : source.imageSelector;
                if (imageSelector) {
                    images = $$(imageSelector)
                        .map((_, img) => $$(img).attr('src') || $$(img).attr('data-src'))
                        .get()
                        .filter(Boolean);
                    images = normalizeImages(images, source.baseUrl || source.url);
                }
                if (isKT && images.length === 0) {
                    const og = $$('meta[property="og:image"]').attr('content') || $$('meta[name="twitter:image"]').attr('content');
                    if (og) images = normalizeImages([og], source.baseUrl || source.url);
                }

                const articleData = {
                    url: link,
                    title: title || 'No title extracted',
                    content: content || 'No content extracted',
                    images: images,
                    contentLength: content.length,
                    titleLength: title.length,
                    imageCount: images.length
                };

                testResults.articles.push(articleData);
                console.log(`📊 Article ${i + 1} - Title: "${title.slice(0, 50)}...", Content: ${content.length} chars, Images: ${images.length}`);

            } catch (articleError) {
                const errorMsg = `Error testing article ${i + 1}: ${articleError.message}`;
                testResults.errors.push(errorMsg);
                console.error(`❌ ${errorMsg}`);
            }
        }

        testResults.steps.push(`✅ Completed testing ${testResults.articles.length} articles`);
        testResults.success = testResults.articles.length > 0 && testResults.articles.some(a => a.title !== 'No title extracted');

        console.log(`🏁 Test completed for ${source.name}`);
        console.log(`📊 Results: ${testResults.articles.length} articles tested, ${testResults.errors.length} errors`);

        return testResults;

    } catch (error) {
        console.error(`❌ Test failed for source ${sourceId}:`, error);
        return {
            source: { name: 'Unknown', url: 'Unknown' },
            steps: ['❌ Test failed during initialization'],
            articles: [],
            errors: [error.message],
            success: false
        };
    }
}

module.exports = testSingleSource;
