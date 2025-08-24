const axios = require('axios');
const cheerio = require('cheerio');
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
        console.log(`📊 Selectors - List: "${source.listSelector}", Link: "${source.linkSelector}", Title: "${source.titleSelector}", Content: "${source.contentSelector}"`);

        const testResults = {
            source: {
                name: source.name,
                url: source.url,
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

        // Step 1: Fetch main page
        testResults.steps.push('Fetching main page...');
        console.log('📥 Fetching main page...');

        const response = await axios.get(source.url, { timeout: 10000 });
        const $ = cheerio.load(response.data);

        testResults.steps.push(`✅ Main page fetched (${response.data.length} bytes)`);
        console.log(`✅ Main page fetched (${response.data.length} bytes)`);

        // Step 2: Extract article links
        testResults.steps.push('Extracting article links...');
        console.log(`🔍 Extracting links with selector: "${source.listSelector}"`);

        const links = [];
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

        testResults.steps.push(`✅ Found ${links.length} article links`);
        console.log(`✅ Found ${links.length} article links`);

        if (links.length === 0) {
            testResults.errors.push('No article links found. Check listSelector and linkSelector.');
            testResults.steps.push('❌ No links found - check selectors');
            return testResults;
        }

        // Step 3: Test first 3 articles
        const testLinks = links.slice(0, 3);
        testResults.steps.push(`Testing first ${testLinks.length} articles...`);

        for (let i = 0; i < testLinks.length; i++) {
            const link = testLinks[i];
            console.log(`🧪 Testing article ${i + 1}: ${link}`);

            try {
                let pageHtml;
                if (source.name.toLowerCase().includes('gulfi news')) {
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
                        pageHtml = (await axios.get(link)).data;
                    }
                } else {
                    pageHtml = (await axios.get(link, { timeout: 10000 })).data;
                }

                const $$ = cheerio.load(pageHtml);

                // Extract title
                const title = cleanText($$(source.titleSelector || '.ORiM7')
                    .filter((_, el) => isElementVisible($$, el))
                    .first()
                    .text());

                // Extract content
                const content = cleanText(
                    $$(source.contentSelector || '.story-element.story-element-text p')
                        .filter((_, p) => isElementVisible($$, p))
                        .map((_, p) => $$(p).text().trim())
                        .get()
                        .filter(text => text.length > 10)
                        .join('\n\n')
                );

                // Extract images
                let images = [];
                if (source.imageSelector) {
                    images = $$(source.imageSelector)
                        .map((_, img) => $$(img).attr('src') || $$(img).attr('data-src'))
                        .get()
                        .filter(Boolean);
                    images = normalizeImages(images, source.baseUrl || source.url);
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
