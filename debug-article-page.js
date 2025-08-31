const axios = require('axios');
const cheerio = require('cheerio');

async function testArticlePage() {
    const url = 'https://www.khaleejtimes.com/business/auto/mercedes-benz-offloads-nissan-stake-for-325-million-source-says';
    const titleSelector = '.article-top-left .recent > h1:first-of-type';
    const contentSelector = '.article-center-wrap-nf:first-of-type .innermixmatch p';

    console.log('🧪 Testing article page selectors...');
    console.log(`URL: ${url}`);
    console.log('');

    try {
        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        console.log(`✅ Article fetched (${response.data.length} bytes)`);

        const $ = cheerio.load(response.data);

        // Test title
        console.log('\n📰 Testing title selector:', titleSelector);
        const title = $(titleSelector).first().text().trim();
        console.log(`Title found: "${title}"`);

        // Test content selector parts
        console.log('\n📝 Testing content selector parts:');

        const contentTests = [
            '.article-center-wrap-nf:first-of-type .innermixmatch p',
            '.article-center-wrap-nf .innermixmatch p',
            '.innermixmatch p',
            '.article-center-wrap-nf p'
        ];

        for (const sel of contentTests) {
            const elements = $(sel);
            console.log(`\n  Selector: ${sel}`);
            console.log(`  Found: ${elements.length} elements`);

            if (elements.length > 0) {
                let content = '';
                elements.each((i, p) => {
                    const text = $(p).text().trim();
                    if (text && text.length > 10) {
                        content += text + '\n\n';
                    }
                });
                console.log(`  Content length: ${content.length} chars`);
                if (content.length > 0) {
                    console.log(`  Preview: "${content.substring(0, 300)}..."`);
                    break; // Found working selector
                }
            }
        }

        // Check for the specific elements in the content path
        console.log('\n🔍 Debugging content element path:');
        console.log('  .article-center-wrap-nf elements:', $('.article-center-wrap-nf').length);
        console.log('  .article-center-wrap-nf:first-of-type elements:', $('.article-center-wrap-nf:first-of-type').length);
        console.log('  .innermixmatch elements:', $('.innermixmatch').length);
        console.log('  .article-center-wrap-nf .innermixmatch elements:', $('.article-center-wrap-nf .innermixmatch').length);
        console.log('  .article-center-wrap-nf:first-of-type .innermixmatch elements:', $('.article-center-wrap-nf:first-of-type .innermixmatch').length);

        // Let's also check all p tags in article content area
        console.log('\n📄 All p elements analysis:');
        const allPs = $('p');
        console.log(`  Total p elements: ${allPs.length}`);

        // Find content-rich p elements
        let contentPs = [];
        allPs.each((i, p) => {
            const text = $(p).text().trim();
            if (text && text.length > 50 && !text.toLowerCase().includes('subscribe') && !text.toLowerCase().includes('newsletter')) {
                contentPs.push({
                    index: i,
                    text: text.substring(0, 100),
                    length: text.length,
                    classes: $(p).attr('class') || 'no-class',
                    parent: $(p).parent().attr('class') || 'no-parent-class'
                });
            }
        });

        console.log(`  Content-rich p elements: ${contentPs.length}`);
        contentPs.slice(0, 5).forEach((p, i) => {
            console.log(`    ${i + 1}. [${p.length} chars] "${p.text}..." (class: ${p.classes}, parent: ${p.parent})`);
        });

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
    }
}

testArticlePage().catch(console.error);
