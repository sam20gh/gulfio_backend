const axios = require('axios');
const cheerio = require('cheerio');

// Simulate the scraper logic
async function testScraperURLLogic() {
    console.log('🔧 Testing Main Scraper URL Construction Logic');
    console.log('==============================================');

    // Mock source without baseUrl (should extract domain)
    const sourceWithoutBaseUrl = {
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']"
    };

    // Mock source with baseUrl (should use baseUrl)
    const sourceWithBaseUrl = {
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        baseUrl: 'https://www.khaleejtimes.com',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']"
    };

    const testSources = [
        { source: sourceWithoutBaseUrl, description: 'Source without baseUrl (domain extraction)' },
        { source: sourceWithBaseUrl, description: 'Source with baseUrl (use baseUrl)' }
    ];

    try {
        const response = await axios.get(sourceWithoutBaseUrl.url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        for (const { source, description } of testSources) {
            console.log(`\n📋 Testing: ${description}`);
            console.log(`   Source URL: ${source.url}`);
            console.log(`   Base URL: ${source.baseUrl || 'not set'}`);

            const listSel = source.listSelector;
            const linkSel = source.linkSelector;
            const links = [];

            $(listSel).each((_, el) => {
                const href = $(el).find(linkSel).attr('href');
                if (href && href !== ':' && href !== '') {
                    let url;
                    if (href.startsWith('http')) {
                        url = href;
                    } else {
                        // This is the UPDATED logic from scrape.js
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
                }
            });

            console.log(`   Found ${links.length} links:`);
            links.slice(0, 3).forEach((link, i) => {
                const isCorrect = !link.includes('//business') && !link.includes('khaleejtimes.com//');
                const status = isCorrect ? '✅' : '❌';
                console.log(`   ${status} ${i + 1}. ${link}`);
            });
        }

        console.log('\n🎯 RECOMMENDATION:');
        console.log('==================');
        console.log('For Khaleej Times, use this configuration:');
        console.log('• url: "https://www.khaleejtimes.com/business/"');
        console.log('• baseUrl: "https://www.khaleejtimes.com"');
        console.log('This will ensure proper URL construction regardless of scraper version.');

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
    }
}

testScraperURLLogic().catch(console.error);
