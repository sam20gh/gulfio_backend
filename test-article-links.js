const axios = require('axios');

async function testArticleLinks() {
    const links = [
        'https://www.khaleejtimes.com/business/auto/mercedes-benz-offloads-nissan-stake-for-325-million-source-says',
        'https://www.khaleejtimes.com/business/auto/tesla-approves-share-award-worth-29-billion-to-ceo-elon-musk',
        'https://www.khaleejtimes.com/business/auto/teslas-brand-loyalty-collapsed-after-musk-backed-trump-data-shows'
    ];

    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        console.log(`\n🧪 Testing article ${i + 1}: ${link}`);

        try {
            const response = await axios.get(link, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://www.khaleejtimes.com/business/',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            });

            console.log(`✅ Article ${i + 1} loaded successfully (${response.data.length} bytes)`);
            console.log(`   Status: ${response.status} ${response.statusText}`);

        } catch (error) {
            console.error(`❌ Article ${i + 1} failed:`);
            if (error.response) {
                console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
                console.error(`   URL: ${link}`);
            } else {
                console.error(`   Error: ${error.message}`);
            }
        }
    }
}

testArticleLinks().catch(console.error);
