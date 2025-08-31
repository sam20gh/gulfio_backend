const axios = require('axios');
const cheerio = require('cheerio');

async function testOptimizedImageSelector() {
    const testUrl = 'https://www.khaleejtimes.com/business/auto/mercedes-benz-offloads-nissan-stake-for-325-million-source-says';

    console.log('🎯 Optimizing Image Selector for Khaleej Times');
    console.log('=============================================');

    try {
        const response = await axios.get(testUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // Test different approaches
        console.log('🔍 Testing different image extraction strategies:\n');

        // Strategy 1: Main content image only
        console.log('1️⃣ Strategy 1 - Main content image only (.img-wrap img):');
        const mainImages = [];
        $('.img-wrap img').each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && src.includes('imgengine.khaleejtimes.com') && !src.includes('fallback')) {
                mainImages.push(src);
            }
        });
        console.log(`   Found: ${mainImages.length} images`);
        mainImages.forEach((img, i) => console.log(`   ${i + 1}. ${img.substring(0, 100)}...`));

        // Strategy 2: All content area images but exclude sidebar
        console.log('\n2️⃣ Strategy 2 - Content area excluding sidebar:');
        const contentImages = [];
        $('.article-center-wrap-nf img[src*="imgengine.khaleejtimes.com"]').each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            const $parent = $(img).parent();
            const parentClass = $parent.attr('class') || '';

            // Exclude sidebar/related article thumbnails
            const isSidebarImage = parentClass.includes('sidebar') ||
                parentClass.includes('g4a_amn_track') ||
                $(img).attr('alt') === 'thumb-image';

            if (src && !src.includes('fallback') && !isSidebarImage) {
                contentImages.push(src);
                console.log(`   ✅ Main: ${src.substring(0, 90)}... (parent: ${parentClass})`);
            } else if (src && isSidebarImage) {
                console.log(`   🔄 Skip: ${src.substring(0, 90)}... (sidebar thumb)`);
            }
        });

        // Strategy 3: Hybrid approach - main image + additional content images
        console.log('\n3️⃣ Strategy 3 - Hybrid (main + additional content):');
        const hybridImages = [];

        // First, get main content images
        $('.img-wrap img[src*="imgengine.khaleejtimes.com"]').each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && !src.includes('fallback')) {
                hybridImages.push({ src, type: 'main-content' });
            }
        });

        // Then, get any additional figure images or story images
        $('figure img[src*="imgengine.khaleejtimes.com"], .story-image img[src*="imgengine.khaleejtimes.com"]').each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && !src.includes('fallback') && !hybridImages.some(h => h.src === src)) {
                hybridImages.push({ src, type: 'additional-content' });
            }
        });

        console.log(`   Found: ${hybridImages.length} images`);
        hybridImages.forEach((img, i) => {
            console.log(`   ${i + 1}. [${img.type}] ${img.src.substring(0, 85)}...`);
        });

        // Recommended selector test
        console.log('\n4️⃣ RECOMMENDED - Combined selector:');
        const recommendedSelector = '.img-wrap img, figure img, .story-image img';
        const recommendedImages = [];

        $(recommendedSelector).each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            const $parent = $(img).parent();
            const parentClass = $parent.attr('class') || '';
            const alt = $(img).attr('alt') || '';

            if (src && src.includes('imgengine.khaleejtimes.com') &&
                !src.includes('fallback') &&
                !parentClass.includes('g4a_amn_track') &&
                alt !== 'thumb-image') {

                if (!recommendedImages.includes(src)) {
                    recommendedImages.push(src);
                }
            }
        });

        console.log(`   Found: ${recommendedImages.length} quality images`);
        recommendedImages.forEach((img, i) => {
            console.log(`   ${i + 1}. ${img}`);
        });

        console.log('\n📊 COMPARISON SUMMARY:');
        console.log('=====================');
        console.log(`Strategy 1 (main only): ${mainImages.length} images`);
        console.log(`Strategy 2 (content area): ${contentImages.length} images`);
        console.log(`Strategy 3 (hybrid): ${hybridImages.length} images`);
        console.log(`Recommended selector: ${recommendedImages.length} images`);

        console.log('\n🎯 FINAL RECOMMENDATION:');
        console.log('========================');
        console.log('Best image selector: .img-wrap img');
        console.log('');
        console.log('Reasoning:');
        console.log('• Gets the main article image (high quality, relevant)');
        console.log('• Avoids sidebar thumbnail clutter');
        console.log('• Simple and reliable selector');
        console.log('• Focuses on editorial content images');
        console.log('');
        console.log('Alternative if more images needed:');
        console.log('img[src*="imgengine.khaleejtimes.com"]:not([alt="thumb-image"])');

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
    }
}

testOptimizedImageSelector().catch(console.error);
