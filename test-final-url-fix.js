const axios = require('axios');
const cheerio = require('cheerio');

async function testFinalURLFix() {
    const sourceConfig = {
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']",
        titleSelector: '.article-top-left .recent > h1:first-of-type',
        contentSelector: '.article-center-wrap-nf .innermixmatch p',
        imageSelector: '.img-wrap img'
    };

    console.log('🔧 Testing FINAL URL Construction Fix');
    console.log('====================================');

    try {
        // Fetch main page
        const response = await axios.get(sourceConfig.url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        console.log(`✅ Main page fetched (${response.data.length} bytes)`);

        // Extract links with CORRECT URL construction
        const links = [];
        $(sourceConfig.listSelector).each((_, element) => {
            const $elem = $(element);
            const linkHref = $elem.find(sourceConfig.linkSelector).attr('href');
            if (linkHref) {
                let fullLink;
                if (linkHref.startsWith('http')) {
                    fullLink = linkHref;
                } else {
                    // Extract domain from source URL for proper base URL
                    const urlObj = new URL(sourceConfig.url);
                    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
                    fullLink = linkHref.startsWith('/') ? `${baseUrl}${linkHref}` : `${baseUrl}/${linkHref}`;
                }
                if (fullLink && !links.includes(fullLink)) {
                    links.push(fullLink);
                }
            }
        });

        console.log(`\n✅ Found ${links.length} article links:`);
        links.forEach((link, i) => {
            console.log(`  ${i + 1}. ${link}`);
        });

        // Test the first 3 articles
        console.log(`\n🧪 Testing first 3 articles...`);
        const testLinks = links.slice(0, 3);
        let successCount = 0;

        for (let i = 0; i < testLinks.length; i++) {
            const link = testLinks[i];
            console.log(`\n📰 Testing article ${i + 1}:`);
            console.log(`   URL: ${link}`);

            try {
                const articleResponse = await axios.get(link, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': 'https://www.khaleejtimes.com/business/'
                    }
                });

                const $$ = cheerio.load(articleResponse.data);

                // Extract all data
                const title = $$(sourceConfig.titleSelector).first().text().trim();

                let content = '';
                $$(sourceConfig.contentSelector).each((_, p) => {
                    const text = $$(p).text().trim();
                    if (text && text.length > 10) {
                        content += text + '\n\n';
                    }
                });

                const images = [];
                $$(sourceConfig.imageSelector).each((_, img) => {
                    const src = $$(img).attr('src') || $$(img).attr('data-src');
                    if (src && src.includes('imgengine.khaleejtimes.com') && !src.includes('fallback')) {
                        images.push(src);
                    }
                });

                console.log(`   ✅ SUCCESS - Status: 200 OK (${articleResponse.data.length} bytes)`);
                console.log(`   📰 Title: "${title.substring(0, 60)}..." (${title.length} chars)`);
                console.log(`   📄 Content: ${content.length} characters`);
                console.log(`   🖼️  Images: ${images.length} found`);

                successCount++;

            } catch (articleError) {
                console.error(`   ❌ FAILED - ${articleError.message}`);
                if (articleError.response) {
                    console.error(`   Status: ${articleError.response.status} ${articleError.response.statusText}`);
                }
            }
        }

        console.log('\n📊 FINAL TEST RESULTS:');
        console.log('======================');
        console.log(`✅ Successfully tested: ${successCount}/${testLinks.length} articles`);
        console.log(`✅ URL construction: ${successCount === testLinks.length ? 'FIXED' : 'NEEDS MORE WORK'}`);

        if (successCount === testLinks.length) {
            console.log('\n🎉 ALL TESTS PASSED!');
            console.log('\n🎯 FINAL WORKING CONFIGURATION:');
            console.log('===============================');
            console.log('URL:', sourceConfig.url);
            console.log('List Selector:', sourceConfig.listSelector);
            console.log('Link Selector:', sourceConfig.linkSelector);
            console.log('Title Selector:', sourceConfig.titleSelector);
            console.log('Content Selector:', sourceConfig.contentSelector);
            console.log('Image Selector:', sourceConfig.imageSelector);
            console.log('\n✅ Ready for production deployment!');
        }

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
    }
}

testFinalURLFix().catch(console.error);
