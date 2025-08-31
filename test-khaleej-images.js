const axios = require('axios');
const cheerio = require('cheerio');

async function testKhaleejtimesImages() {
    const testUrl = 'https://www.khaleejtimes.com/business/auto/mercedes-benz-offloads-nissan-stake-for-325-million-source-says';

    console.log('🖼️  Testing Khaleej Times Image Selectors');
    console.log('=========================================');
    console.log(`URL: ${testUrl}`);
    console.log('');

    try {
        const response = await axios.get(testUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Referer': 'https://www.khaleejtimes.com/business/'
            }
        });

        console.log(`✅ Article fetched (${response.data.length} bytes)`);

        const $ = cheerio.load(response.data);

        // Test various image selectors
        const imageSelectors = [
            // Article content images
            '.article-center-wrap-nf img',
            '.innermixmatch img',
            '.story-element img',
            '.article-body img',
            '.content img',

            // Hero/featured images
            '.article-top-left img',
            '.hero-image img',
            '.featured-image img',
            '.main-image img',

            // General article images
            'article img',
            '.article img',

            // All images (for comparison)
            'img'
        ];

        console.log('🔍 Testing image selectors:\n');

        for (const selector of imageSelectors) {
            const images = $(selector);
            console.log(`📸 Selector: ${selector}`);
            console.log(`   Found: ${images.length} images`);

            if (images.length > 0 && images.length <= 10) {
                images.each((i, img) => {
                    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
                    const alt = $(img).attr('alt') || 'no-alt';
                    const classes = $(img).attr('class') || 'no-class';
                    const parent = $(img).parent().attr('class') || 'no-parent-class';

                    if (src) {
                        // Check if it's a content image (not icon, logo, etc.)
                        const isContentImage = !src.includes('icon') &&
                            !src.includes('logo') &&
                            !src.includes('placeholder') &&
                            !src.includes('fallback') &&
                            !alt.toLowerCase().includes('icon') &&
                            !alt.toLowerCase().includes('logo');

                        const marker = isContentImage ? '✅' : '⚠️';
                        console.log(`     ${marker} ${i + 1}. src="${src.substring(0, 80)}..."`);
                        console.log(`        alt="${alt.substring(0, 50)}..." class="${classes}"`);
                        console.log(`        parent-class="${parent}"`);
                    }
                });
            } else if (images.length > 10) {
                console.log(`   (Too many to list - showing first 3)`);
                images.slice(0, 3).each((i, img) => {
                    const src = $(img).attr('src') || $(img).attr('data-src');
                    const alt = $(img).attr('alt') || 'no-alt';
                    if (src) {
                        console.log(`     ${i + 1}. src="${src.substring(0, 80)}..."`);
                        console.log(`        alt="${alt.substring(0, 50)}..."`);
                    }
                });
            }
            console.log('');
        }

        // Find the best content images
        console.log('🎯 Analyzing for best content images:\n');

        const contentImages = [];
        const excludePatterns = [
            'icon', 'logo', 'placeholder', 'fallback', 'avatar', 'profile',
            'social', 'share', 'twitter', 'facebook', 'instagram', 'whatsapp',
            '1x1', 'pixel', 'tracker', 'analytics', 'ad-', 'advertisement'
        ];

        $('img').each((i, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
            const alt = $(img).attr('alt') || '';
            const classes = $(img).attr('class') || '';
            const parent = $(img).parent();
            const parentClass = parent.attr('class') || '';

            if (src) {
                const srcLower = src.toLowerCase();
                const altLower = alt.toLowerCase();
                const classLower = classes.toLowerCase();

                // Check if this is likely a content image
                const isExcluded = excludePatterns.some(pattern =>
                    srcLower.includes(pattern) || altLower.includes(pattern) || classLower.includes(pattern)
                );

                if (!isExcluded && src.includes('khaleejtimes') &&
                    (src.includes('image') || src.includes('photo') || src.includes('article'))) {

                    // Get image dimensions if available
                    const width = $(img).attr('width') || 'unknown';
                    const height = $(img).attr('height') || 'unknown';

                    contentImages.push({
                        src,
                        alt: alt.substring(0, 100),
                        classes,
                        parentClass,
                        dimensions: `${width}x${height}`,
                        inContent: parent.closest('.innermixmatch, .article-center-wrap-nf, .story-element').length > 0
                    });
                }
            }
        });

        console.log(`Found ${contentImages.length} potential content images:`);
        contentImages.forEach((img, i) => {
            const marker = img.inContent ? '✅' : '📸';
            console.log(`${marker} ${i + 1}. ${img.src.substring(0, 100)}...`);
            console.log(`     alt="${img.alt}" (${img.dimensions})`);
            console.log(`     classes="${img.classes}" parent="${img.parentClass}"`);
            console.log(`     in-content-area: ${img.inContent}`);
            console.log('');
        });

        // Recommend best selector
        console.log('🎯 RECOMMENDED IMAGE SELECTORS:');
        console.log('==============================');

        if (contentImages.some(img => img.inContent)) {
            console.log('✅ Primary recommendation: .article-center-wrap-nf img, .innermixmatch img');
            console.log('   This targets images within the article content area');
        }

        console.log('✅ Alternative: article img (broader but may include non-content images)');
        console.log('✅ Conservative: .story-element img (if story elements exist)');

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
        }
    }
}

testKhaleejtimesImages().catch(console.error);
