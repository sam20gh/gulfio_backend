const axios = require('axios');
const cheerio = require('cheerio');

async function testKhaleejtimes() {
    const url = 'https://www.khaleejtimes.com/business/';
    const listSelector = '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows';
    const linkSelector = "h3 > a[href^='/'], h4 > a[href^='/']";
    const titleSelector = '.article-top-left .recent > h1:first-of-type';
    const contentSelector = '.article-center-wrap-nf:first-of-type .innermixmatch p';

    console.log('🧪 Testing Khaleej Times scraping...');
    console.log(`URL: ${url}`);
    console.log(`List Selector: ${listSelector}`);
    console.log(`Link Selector: ${linkSelector}`);
    console.log(`Title Selector: ${titleSelector}`);
    console.log(`Content Selector: ${contentSelector}`);
    console.log('');

    try {
        console.log('Fetching main page...');
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });

        console.log(`✅ Main page fetched (${response.data.length} bytes)`);

        const $ = cheerio.load(response.data);

        console.log('\nExtracting article links...');

        // Test list selector
        const listElements = $(listSelector);
        console.log(`Found ${listElements.length} list elements`);

        if (listElements.length === 0) {
            console.log('❌ No list elements found. Let me check for similar elements...');

            // Debug: check for common article containers
            const debugSelectors = [
                '.rendered_board_article',
                '.post-title-rows',
                '.kt-section-top-with-listing',
                '.listing-blog-teaser-outer',
                'article',
                '.article',
                '.post',
                '[class*="article"]',
                '[class*="post"]'
            ];

            for (const sel of debugSelectors) {
                const found = $(sel);
                if (found.length > 0) {
                    console.log(`  - Found ${found.length} elements with selector: ${sel}`);
                    if (found.length <= 5) {
                        found.each((i, el) => {
                            const classes = $(el).attr('class') || 'no-classes';
                            console.log(`    Element ${i + 1}: classes="${classes}"`);
                        });
                    }
                }
            }
            return;
        }

        const links = [];
        listElements.each((index, element) => {
            const $elem = $(element);
            console.log(`\nProcessing list element ${index + 1}:`);
            console.log(`  Element classes: ${$elem.attr('class') || 'none'}`);

            // Find link within this element
            const linkElement = $elem.find(linkSelector);
            console.log(`  Found ${linkElement.length} link elements with selector: ${linkSelector}`);

            if (linkElement.length > 0) {
                const href = linkElement.first().attr('href');
                console.log(`  Link href: ${href}`);

                if (href) {
                    const fullLink = href.startsWith('http') ? href : `https://www.khaleejtimes.com${href}`;
                    links.push(fullLink);
                    console.log(`  Full link: ${fullLink}`);
                }
            } else {
                // Debug: show what's inside this element
                console.log(`  Element HTML preview: ${$elem.html()?.substring(0, 200)}...`);
            }
        });

        console.log(`\n✅ Found ${links.length} article links`);
        links.forEach((link, i) => {
            console.log(`  ${i + 1}. ${link}`);
        });

        if (links.length === 0) {
            console.log('\n❌ No links found. Debugging link selectors...');

            // Test individual parts of the link selector
            const linkTests = [
                "h3 > a[href^='/']",
                "h4 > a[href^='/']",
                "h3 > a",
                "h4 > a",
                "a[href^='/']",
                "a[href*='/']",
                "h3 a",
                "h4 a"
            ];

            listElements.each((index, element) => {
                const $elem = $(element);
                console.log(`\n  Testing in list element ${index + 1}:`);

                for (const testSel of linkTests) {
                    const found = $elem.find(testSel);
                    if (found.length > 0) {
                        console.log(`    Found ${found.length} links with: ${testSel}`);
                        found.each((i, a) => {
                            const href = $(a).attr('href');
                            const text = $(a).text().trim();
                            console.log(`      Link ${i + 1}: href="${href}" text="${text.substring(0, 50)}..."`);
                        });
                    }
                }
            });
            return;
        }

        // Test first article
        console.log('\n🧪 Testing first article...');
        const testLink = links[0];
        console.log(`Testing: ${testLink}`);

        try {
            const articleResponse = await axios.get(testLink, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });

            console.log(`✅ Article page fetched (${articleResponse.data.length} bytes)`);

            const $$ = cheerio.load(articleResponse.data);

            // Test title selector
            console.log('\nTesting title selector...');
            const titleElement = $$(titleSelector);
            console.log(`Found ${titleElement.length} title elements`);

            if (titleElement.length > 0) {
                const title = titleElement.first().text().trim();
                console.log(`✅ Title: "${title}"`);
            } else {
                console.log('❌ No title found. Testing alternatives...');
                const titleTests = [
                    'h1',
                    '.article-top-left h1',
                    '.recent h1',
                    '[class*="title"]',
                    '[class*="headline"]'
                ];

                for (const sel of titleTests) {
                    const found = $$(sel);
                    if (found.length > 0) {
                        console.log(`  Found ${found.length} elements with: ${sel}`);
                        found.each((i, el) => {
                            const text = $$(el).text().trim();
                            if (text) {
                                console.log(`    ${i + 1}. "${text.substring(0, 80)}..."`);
                            }
                        });
                    }
                }
            }

            // Test content selector
            console.log('\nTesting content selector...');
            const contentElements = $$(contentSelector);
            console.log(`Found ${contentElements.length} content elements`);

            if (contentElements.length > 0) {
                let content = '';
                contentElements.each((i, p) => {
                    const text = $$(p).text().trim();
                    if (text && text.length > 10) {
                        content += text + '\n\n';
                    }
                });
                console.log(`✅ Content extracted (${content.length} chars)`);
                console.log(`Preview: "${content.substring(0, 200)}..."`);
            } else {
                console.log('❌ No content found. Testing alternatives...');
                const contentTests = [
                    '.article-center-wrap-nf p',
                    '.innermixmatch p',
                    '.story-element p',
                    '.content p',
                    'article p',
                    '[class*="content"] p',
                    '[class*="body"] p'
                ];

                for (const sel of contentTests) {
                    const found = $$(sel);
                    if (found.length > 0) {
                        console.log(`  Found ${found.length} p elements with: ${sel}`);
                        if (found.length <= 3) {
                            found.each((i, p) => {
                                const text = $$(p).text().trim();
                                if (text) {
                                    console.log(`    ${i + 1}. "${text.substring(0, 100)}..."`);
                                }
                            });
                        }
                    }
                }
            }

        } catch (articleError) {
            console.error(`❌ Error fetching article: ${articleError.message}`);
            if (articleError.response) {
                console.error(`   Status: ${articleError.response.status} ${articleError.response.statusText}`);
            }
        }

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
        }
    }
}

testKhaleejtimes().catch(console.error);
