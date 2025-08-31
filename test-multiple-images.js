const axios = require('axios');
const cheerio = require('cheerio');

async function testMultipleArticleImages() {
    const testUrls = [
        'https://www.khaleejtimes.com/business/auto/mercedes-benz-offloads-nissan-stake-for-325-million-source-says',
        'https://www.khaleejtimes.com/business/auto/tesla-approves-share-award-worth-29-billion-to-ceo-elon-musk',
        'https://www.khaleejtimes.com/business/auto/teslas-brand-loyalty-collapsed-after-musk-backed-trump-data-shows'
    ];

    console.log('🖼️  Testing Multiple Khaleej Times Articles for Images');
    console.log('====================================================');

    for (let i = 0; i < testUrls.length; i++) {
        const url = testUrls[i];
        console.log(`\n📰 Article ${i + 1}: ${url}`);

        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.khaleejtimes.com/business/'
                }
            });

            const $ = cheerio.load(response.data);

            // Check for main article image (hero image)
            console.log('\n🎯 Looking for main article image:');

            const heroSelectors = [
                '.article-top-left .recent img',
                '.article-hero img',
                '.main-image img',
                '.featured-image img',
                '.article-image img',
                '.hero img'
            ];

            let mainImageFound = false;
            for (const sel of heroSelectors) {
                const heroImages = $(sel);
                if (heroImages.length > 0) {
                    console.log(`   Found ${heroImages.length} images with: ${sel}`);
                    heroImages.each((j, img) => {
                        const src = $(img).attr('src') || $(img).attr('data-src');
                        const alt = $(img).attr('alt') || 'no-alt';
                        if (src && !src.includes('fallback') && !src.includes('placeholder')) {
                            console.log(`     ✅ ${j + 1}. ${src.substring(0, 80)}...`);
                            console.log(`        alt: "${alt.substring(0, 60)}..."`);
                            mainImageFound = true;
                        }
                    });
                }
            }

            // Check for content images in different areas
            console.log('\n📸 Content images analysis:');

            const contentSelectors = [
                '.img-wrap img',
                '.article-center-wrap-nf .img-wrap img',
                '.innermixmatch .img-wrap img',
                'figure img',
                '.story-image img',
                '.article-content img'
            ];

            let contentImagesFound = 0;
            for (const sel of contentSelectors) {
                const images = $(sel);
                if (images.length > 0) {
                    console.log(`   ${sel}: ${images.length} images`);
                    images.each((j, img) => {
                        const src = $(img).attr('src') || $(img).attr('data-src');
                        if (src && src.includes('imgengine.khaleejtimes.com') &&
                            !src.includes('fallback') && !src.includes('placeholder')) {
                            console.log(`     ✅ Content image: ${src.substring(0, 80)}...`);
                            contentImagesFound++;
                        }
                    });
                }
            }

            // Check all images with better filtering
            console.log('\n🔍 All quality images in article:');
            const allImages = $('img');
            let qualityImages = [];

            allImages.each((j, img) => {
                const src = $(img).attr('src') || $(img).attr('data-src');
                const alt = $(img).attr('alt') || '';
                const width = $(img).attr('width') || '';
                const height = $(img).attr('height') || '';

                if (src && src.includes('imgengine.khaleejtimes.com')) {
                    // This is likely a content image from Khaleej Times' CDN
                    const isLargeEnough = (!width || parseInt(width) > 100) && (!height || parseInt(height) > 100);
                    const isNotIcon = !src.includes('icon') && !alt.toLowerCase().includes('icon');
                    const isNotFallback = !src.includes('fallback') && !src.includes('placeholder');

                    if (isLargeEnough && isNotIcon && isNotFallback) {
                        qualityImages.push({
                            src,
                            alt: alt.substring(0, 80),
                            dimensions: `${width || '?'}x${height || '?'}`,
                            parent: $(img).parent().attr('class') || 'no-parent-class'
                        });
                    }
                }
            });

            console.log(`   Found ${qualityImages.length} quality images:`);
            qualityImages.forEach((img, idx) => {
                console.log(`     ${idx + 1}. ${img.src.substring(0, 90)}...`);
                console.log(`        alt: "${img.alt}" (${img.dimensions}) parent: ${img.parent}`);
            });

        } catch (error) {
            console.error(`❌ Error testing article ${i + 1}: ${error.message}`);
        }
    }

    console.log('\n🎯 FINAL IMAGE SELECTOR RECOMMENDATIONS:');
    console.log('=====================================');
    console.log('Based on the analysis, here are the recommended selectors:');
    console.log('');
    console.log('✅ For main article image (hero):');
    console.log('   .article-top-left .recent img, .article-hero img');
    console.log('');
    console.log('✅ For content images:');
    console.log('   .img-wrap img, .innermixmatch .img-wrap img');
    console.log('');
    console.log('✅ For all article images (comprehensive):');
    console.log('   img[src*="imgengine.khaleejtimes.com"]:not([src*="fallback"]):not([src*="placeholder"])');
    console.log('');
    console.log('✅ Conservative approach (content area only):');
    console.log('   .article-center-wrap-nf img[src*="imgengine.khaleejtimes.com"]');
}

testMultipleArticleImages().catch(console.error);
