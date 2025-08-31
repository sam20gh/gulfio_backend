const axios = require('axios');
const cheerio = require('cheerio');

async function testFinalKhaleejtimesConfig() {
    const sourceConfig = {
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']",
        titleSelector: '.article-top-left .recent > h1:first-of-type',
        contentSelector: '.article-center-wrap-nf .innermixmatch p',
        imageSelector: '.img-wrap img' // Main content images
    };

    console.log('🎯 FINAL Khaleej Times Configuration Test');
    console.log('========================================');
    console.log(`Source: ${sourceConfig.name}`);
    console.log(`URL: ${sourceConfig.url}`);
    console.log(`Image Selector: ${sourceConfig.imageSelector}`);
    console.log('');

    // Function to normalize and filter images
    function normalizeImages(imgs, baseUrl) {
        const EXCLUDE_FILES = new Set([
            'whatsapp-logo.svg', 'facebook_isa-nf.svg', 'x-isa-nf2.svg', 'linkedin-isa-nf.svg',
            'google-news-icon.svg', 'whatsapp-icon.svg', 'telegram-icon.svg', 'fallbackPlaceholder'
        ]);

        return Array.from(new Set(
            (imgs || [])
                .filter(src => src && src.trim())
                .filter(src => !src.includes('data:')) // Remove data URLs
                .filter(src => {
                    const fileName = src.split('/').pop().toLowerCase();
                    return !EXCLUDE_FILES.has(fileName) && !fileName.includes('icon') && !fileName.includes('placeholder');
                })
                .filter(src => src.includes('imgengine.khaleejtimes.com')) // Only Khaleej Times CDN images
                .map(src => {
                    // Ensure full URL
                    if (src.startsWith('//')) return 'https:' + src;
                    if (src.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${src}`;
                    return src;
                })
                .filter(src => {
                    try {
                        new URL(src); // Validate URL
                        return true;
                    } catch {
                        return false;
                    }
                })
        ));
    }

    try {
        // Step 1: Fetch and extract links
        console.log('📥 Fetching main page and extracting links...');
        const response = await axios.get(sourceConfig.url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const links = [];
        $(sourceConfig.listSelector).each((_, element) => {
            const $elem = $(element);
            const linkHref = $elem.find(sourceConfig.linkSelector).attr('href');
            if (linkHref) {
                const fullLink = linkHref.startsWith('http') ? linkHref : `https://www.khaleejtimes.com${linkHref}`;
                if (!links.includes(fullLink)) {
                    links.push(fullLink);
                }
            }
        });

        console.log(`✅ Found ${links.length} article links`);

        // Step 2: Test image extraction on first article
        console.log(`\n📰 Testing complete extraction on first article...`);
        const testLink = links[0];
        console.log(`URL: ${testLink}`);

        const articleResponse = await axios.get(testLink, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $$ = cheerio.load(articleResponse.data);

        // Extract title
        const title = $$(sourceConfig.titleSelector).first().text().trim();

        // Extract content
        let content = '';
        $$(sourceConfig.contentSelector).each((_, p) => {
            const text = $$(p).text().trim();
            if (text && text.length > 10) {
                content += text + '\n\n';
            }
        });

        // Extract images using the selector
        console.log(`\n🖼️  Testing image selector: ${sourceConfig.imageSelector}`);
        const rawImages = [];
        $$(sourceConfig.imageSelector).each((_, img) => {
            const src = $$(img).attr('src') || $$(img).attr('data-src') || $$(img).attr('data-lazy-src');
            if (src) {
                rawImages.push(src);
            }
        });

        console.log(`Raw images found: ${rawImages.length}`);
        rawImages.forEach((img, i) => {
            console.log(`  ${i + 1}. ${img}`);
        });

        // Normalize and filter images
        const normalizedImages = normalizeImages(rawImages, 'https://www.khaleejtimes.com');
        console.log(`\n✅ Filtered images: ${normalizedImages.length}`);
        normalizedImages.forEach((img, i) => {
            console.log(`  ${i + 1}. ${img}`);
        });

        // Test alternative selectors for comparison
        console.log(`\n🔄 Testing alternative image selectors:`);
        const altSelectors = [
            'img[src*="imgengine.khaleejtimes.com"]',
            '.article-center-wrap-nf img[src*="imgengine.khaleejtimes.com"]',
            '.innermixmatch img[src*="imgengine.khaleejtimes.com"]'
        ];

        for (const altSel of altSelectors) {
            const altImages = [];
            $$(altSel).each((_, img) => {
                const src = $$(img).attr('src') || $$(img).attr('data-src');
                if (src) altImages.push(src);
            });
            const filtered = normalizeImages(altImages, 'https://www.khaleejtimes.com');
            console.log(`  ${altSel}: ${filtered.length} images`);
        }

        // Final results
        console.log('\n📊 EXTRACTION RESULTS:');
        console.log('====================');
        console.log(`Title: "${title}"`);
        console.log(`Content: ${content.length} characters`);
        console.log(`Images: ${normalizedImages.length} found`);
        console.log(`Title OK: ${title.length > 0}`);
        console.log(`Content OK: ${content.length > 100}`);
        console.log(`Images OK: ${normalizedImages.length > 0}`);

        const success = title.length > 0 && content.length > 100 && normalizedImages.length > 0;
        console.log(`\n${success ? '✅' : '❌'} Overall extraction: ${success ? 'SUCCESS' : 'NEEDS IMPROVEMENT'}`);

        if (success) {
            console.log('\n🎯 RECOMMENDED FINAL CONFIGURATION:');
            console.log('===================================');
            console.log(JSON.stringify(sourceConfig, null, 2));
        }

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
    }
}

testFinalKhaleejtimesConfig().catch(console.error);
