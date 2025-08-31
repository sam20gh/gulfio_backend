const testSingleSource = require('./scraper/testSingleSource');

// Test with a mock source configuration for Khaleej Times
async function testKhaleejtimesFixed() {
    // Create a temporary source object to test with
    const mockSource = {
        _id: 'test-khaleej-times',
        name: 'Khaleej Times Business',
        url: 'https://www.khaleejtimes.com/business/',
        listSelector: '.rendered_board_article .post-title-rows, .kt-section-top-with-listing .listing-blog-teaser-outer .post-title-rows',
        linkSelector: "h3 > a[href^='/'], h4 > a[href^='/']",
        titleSelector: '.article-top-left .recent > h1:first-of-type',
        contentSelector: '.article-center-wrap-nf .innermixmatch p',
        imageSelector: '.img-wrap img'
    };

    console.log('🧪 Testing Fixed Khaleej Times Configuration');
    console.log('==========================================');

    // Mock the Source.findById to return our test source
    const mongoose = require('mongoose');
    const Source = require('./models/Source');

    // Save original method
    const originalFindById = Source.findById;

    // Mock the method
    Source.findById = async (id) => {
        if (id === 'test-khaleej-times') {
            return mockSource;
        }
        return originalFindById.call(Source, id);
    };

    try {
        const results = await testSingleSource('test-khaleej-times');

        console.log('\n📊 TEST RESULTS:');
        console.log('===============');
        console.log(`Success: ${results.success}`);
        console.log(`Articles tested: ${results.articles.length}`);
        console.log(`Errors: ${results.errors.length}`);

        if (results.errors.length > 0) {
            console.log('\n❌ Errors:');
            results.errors.forEach(error => console.log(`  - ${error}`));
        }

        if (results.articles.length > 0) {
            console.log('\n✅ Articles:');
            results.articles.forEach((article, i) => {
                console.log(`\n  Article ${i + 1}:`);
                console.log(`    URL: ${article.url}`);
                console.log(`    Title: "${article.title.substring(0, 60)}..."`);
                console.log(`    Content: ${article.contentLength} chars`);
                console.log(`    Images: ${article.imageCount}`);
            });
        }

        console.log('\n🎯 FINAL CONFIGURATION STATUS:');
        console.log('==============================');
        if (results.success && results.articles.length >= 2) {
            console.log('✅ Configuration is WORKING PERFECTLY!');
            console.log('\nRecommended settings:');
            console.log(`URL: ${mockSource.url}`);
            console.log(`List Selector: ${mockSource.listSelector}`);
            console.log(`Link Selector: ${mockSource.linkSelector}`);
            console.log(`Title Selector: ${mockSource.titleSelector}`);
            console.log(`Content Selector: ${mockSource.contentSelector}`);
            console.log(`Image Selector: ${mockSource.imageSelector}`);
        } else {
            console.log('❌ Configuration needs adjustment');
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        // Restore original method
        Source.findById = originalFindById;
    }
}

testKhaleejtimesFixed().catch(console.error);
