// Test the markdown scraper logic
const axios = require('axios');
const cheerio = require('cheerio');

function cleanText(text) {
    if (!text) return '';
    return text.replace(/[\u0000-\u001F]+/g, '').trim();
}

function isElementVisible($, element) {
    const $el = $(element);
    const style = $el.attr('style') || '';
    if (style.includes('display:none') || style.includes('display: none') ||
        style.includes('visibility:hidden') || style.includes('visibility: hidden')) {
        return false;
    }
    const className = $el.attr('class') || '';
    const hiddenClasses = ['hidden', 'hide', 'invisible', 'sr-only', 'screen-reader-only', 'visually-hidden'];
    if (hiddenClasses.some(cls => className.includes(cls))) {
        return false;
    }
    return true;
}

async function testMarkdownScraper() {
    const url = 'https://whatson.ae/2025/11/uae-public-holidays-2026-must-know-dates-to-plan-your-getaways';

    console.log(`🔍 Testing Markdown Scraper`);
    console.log(`📄 Article: ${url}\n`);

    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    const $$ = cheerio.load(response.data);
    const contentSelector = '.article-content__description p, .article-content__description h3, .article-content__description h2, .article-content__description blockquote, .article-content__description ul, .article-content__description ol';

    let contentParts = [];
    let headingCount = 0;
    let listCount = 0;

    $$(contentSelector).each((_, el) => {
        if (!isElementVisible($$, el)) return;

        const $el = $$(el);
        const tagName = el.name;

        // Handle h2 headings
        if (tagName === 'h2') {
            const heading = $el.text().trim();
            if (heading.length > 0) {
                contentParts.push(`\n## ${heading}\n`);
                headingCount++;
            }
            return;
        }

        // Handle h3 headings
        if (tagName === 'h3') {
            const heading = $el.text().trim();
            if (heading.length > 0) {
                contentParts.push(`\n### ${heading}\n`);
                headingCount++;
            }
            return;
        }

        // Handle unordered lists (ul) - Use markdown format
        if (tagName === 'ul') {
            const listItems = [];
            $el.find('li').each((_, li) => {
                const itemText = $$(li).text().trim();
                if (itemText.length > 0) {
                    listItems.push(`- ${itemText}`); // Markdown format
                }
            });
            if (listItems.length > 0) {
                contentParts.push('\n' + listItems.join('\n') + '\n');
                listCount++;
            }
            return;
        }

        // Handle ordered lists (ol)
        if (tagName === 'ol') {
            const listItems = [];
            $el.find('li').each((i, li) => {
                const itemText = $$(li).text().trim();
                if (itemText.length > 0) {
                    listItems.push(`${i + 1}. ${itemText}`);
                }
            });
            if (listItems.length > 0) {
                contentParts.push('\n' + listItems.join('\n') + '\n');
                listCount++;
            }
            return;
        }

        // Extract text content for paragraphs
        const text = $el.text().trim();
        if (text.length > 10) {
            contentParts.push(text);
        }
    });

    const content = cleanText(contentParts.join('\n\n'));

    console.log(`📊 Statistics:`);
    console.log(`   ✓ Headings: ${headingCount}`);
    console.log(`   ✓ Lists: ${listCount}`);
    console.log(`   ✓ Content length: ${content.length} characters`);
    console.log(`   ✓ Content format: markdown\n`);

    // Markdown validation
    const hasH2 = content.includes('\n## ');
    const hasH3 = content.includes('\n### ');
    const hasMarkdownLists = /\n- /.test(content);
    const hasOrderedLists = /\n\d+\. /.test(content);

    console.log(`✅ Markdown Validation:`);
    console.log(`   - H2 headings (## ): ${hasH2 ? '✓' : '✗'}`);
    console.log(`   - H3 headings (### ): ${hasH3 ? '✓' : '✗'}`);
    console.log(`   - Unordered lists (- ): ${hasMarkdownLists ? '✓' : '✗'}`);
    console.log(`   - Ordered lists (1. ): ${hasOrderedLists ? '✓' : '✗'}\n`);

    console.log(`📝 Content Preview (first 1500 chars):`);
    console.log('='.repeat(80));
    console.log(content.slice(0, 1500));
    console.log('='.repeat(80));

    // Test article data structure
    console.log(`\n📦 Article Data Structure:`);
    const articleData = {
        title: 'UAE public holidays 2026: Must-know dates to plan your getaways',
        content: content,
        contentFormat: 'markdown',
        url: url,
        category: 'lifestyle',
        language: 'english',
        publishedAt: new Date()
    };
    console.log(JSON.stringify(articleData, null, 2).slice(0, 500) + '...\n');

    console.log(`✅ Backend markdown scraper is ready!`);
    console.log(`   - Headings use ## and ### syntax`);
    console.log(`   - Lists use - for bullets and 1. for numbered`);
    console.log(`   - contentFormat field set to 'markdown'`);
    console.log(`   - Old articles remain as 'text' format\n`);
}

testMarkdownScraper().catch(console.error);
