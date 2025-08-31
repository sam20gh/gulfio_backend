const axios = require('axios');
const cheerio = require('cheerio');

async function debugURLConstruction() {
    const url = 'https://www.khaleejtimes.com/business/';
    const listSelector = '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows';
    const linkSelector = "h3 > a[href^='/'], h4 > a[href^='/']";

    console.log('🔍 Debugging URL Construction Issue');
    console.log('===================================');

    try {
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        console.log('\n📋 Analyzing href values:');
        console.log('=========================');

        $(listSelector).each((index, element) => {
            const $elem = $(element);
            const linkElement = $elem.find(linkSelector);

            if (linkElement.length > 0) {
                const href = linkElement.first().attr('href');
                console.log(`\nElement ${index + 1}:`);
                console.log(`  Raw href: "${href}"`);

                if (href) {
                    // Show different construction methods
                    console.log(`  Method 1 (current): https://www.khaleejtimes.com/business${href}`);
                    console.log(`  Method 2 (domain only): https://www.khaleejtimes.com${href}`);
                    console.log(`  Method 3 (check existing): ${href.startsWith('http') ? href : `https://www.khaleejtimes.com${href}`}`);
                }
            }
        });

        console.log('\n🎯 SOLUTION:');
        console.log('============');
        console.log('The issue is that we should use the domain root (https://www.khaleejtimes.com)');
        console.log('as the base URL, not the section URL (https://www.khaleejtimes.com/business/)');
        console.log('');
        console.log('Correct approach:');
        console.log('• Base URL: https://www.khaleejtimes.com');
        console.log('• href: /business/auto/article-name');
        console.log('• Result: https://www.khaleejtimes.com/business/auto/article-name');

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
    }
}

debugURLConstruction().catch(console.error);
