const axios = require('axios');
const cheerio = require('cheerio');

async function testKhaleejtimesComplete() {
    const sourceConfig = {
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']",
        titleSelector: '.article-top-left .recent > h1:first-of-type',
        contentSelector: '.article-center-wrap-nf .innermixmatch p' // Fixed: removed :first-of-type
    };

    console.log('🧪 Complete Khaleej Times Scraping Test');
    console.log('=====================================');
    console.log(`Source: ${sourceConfig.name}`);
    console.log(`URL: ${sourceConfig.url}`);
    console.log('');

    try {
        // Step 1: Fetch main page
        console.log('📥 Fetching main page...');
        const response = await axios.get(sourceConfig.url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://www.khaleejtimes.com/',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        console.log(`✅ Main page fetched (${response.data.length} bytes)`);

        const $ = cheerio.load(response.data);

        // Step 2: Extract article links
        console.log('\n🔗 Extracting article links...');
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

        if (links.length === 0) {
            console.log('❌ No article links found - check selectors');
            return;
        }

        // Step 3: Test first 3 articles
        console.log('\n📰 Testing first 3 articles...');
        const testLinks = links.slice(0, 3);
        const results = [];

        for (let i = 0; i < testLinks.length; i++) {
            const link = testLinks[i];
            console.log(`\n🧪 Testing article ${i + 1}: ${link}`);

            try {
                const articleResponse = await axios.get(link, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Referer': 'https://www.khaleejtimes.com/business/'
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

                // Extract images (basic implementation)
                const images = [];
                $$('img').each((_, img) => {
                    const src = $$(img).attr('src') || $$(img).attr('data-src');
                    if (src && !src.includes('placeholder') && !src.includes('fallback')) {
                        const fullSrc = src.startsWith('http') ? src : `https://www.khaleejtimes.com${src}`;
                        if (!images.includes(fullSrc)) {
                            images.push(fullSrc);
                        }
                    }
                });

                const result = {
                    url: link,
                    title: title || 'No title extracted',
                    content: content || 'No content extracted',
                    images: images.slice(0, 3), // First 3 images
                    stats: {
                        titleLength: title.length,
                        contentLength: content.length,
                        imageCount: images.length
                    }
                };

                results.push(result);

                console.log(`✅ Article ${i + 1} processed successfully`);
                console.log(`   Title: "${title.substring(0, 60)}..."`);
                console.log(`   Content: ${content.length} characters`);
                console.log(`   Images: ${images.length} found`);

            } catch (articleError) {
                console.error(`❌ Error testing article ${i + 1}: ${articleError.message}`);
                if (articleError.response) {
                    console.error(`   Status: ${articleError.response.status} ${articleError.response.statusText}`);
                }
            }
        }

        console.log('\n📊 FINAL RESULTS');
        console.log('================');
        console.log(`✅ Successfully scraped ${results.length} out of ${testLinks.length} articles`);

        if (results.length > 0) {
            console.log('\n📝 Article summaries:');
            results.forEach((article, i) => {
                console.log(`\n${i + 1}. ${article.title}`);
                console.log(`   URL: ${article.url}`);
                console.log(`   Content: ${article.stats.contentLength} chars`);
                console.log(`   Images: ${article.stats.imageCount}`);
                if (article.content !== 'No content extracted') {
                    console.log(`   Preview: "${article.content.substring(0, 150)}..."`);
                }
            });

            console.log('\n✅ SCRAPING TEST SUCCESSFUL!');
            console.log(`📋 Recommended content selector: ${sourceConfig.contentSelector}`);
        } else {
            console.log('\n❌ No articles were successfully scraped');
        }

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
    }
}

testKhaleejtimesComplete().catch(console.error);
