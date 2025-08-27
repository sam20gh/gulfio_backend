const mongoose = require('mongoose');
require('dotenv').config();
const AdRevenueEvent = require('./models/AdRevenueEvent');
const Source = require('./models/Source');
const Article = require('./models/Article');

async function testAdRevenueModel() {
    try {
        await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
        console.log('✅ Database connection successful');

        // Get sample data for testing
        const sampleArticle = await Article.findOne().select('_id');
        const sampleSource = await Source.findOne().select('_id name');

        if (!sampleArticle || !sampleSource) {
            console.log('⚠️ No sample data found. Skipping model test.');
            await mongoose.disconnect();
            process.exit(0);
        }

        console.log('📊 Testing AdRevenueEvent model...');

        // Create a test event
        const testEvent = new AdRevenueEvent({
            adUnitId: 'TEST',
            articleId: sampleArticle._id,
            sourceId: sampleSource._id,
            sourceName: sampleSource.name,
            value: 50000, // $0.05 in micro-units
            currency: 'USD',
            precision: 2,
            platform: 'ios'
        });

        await testEvent.save();
        console.log('✅ AdRevenueEvent model working correctly');
        console.log(`💰 Test event: $${(testEvent.value / 1000000).toFixed(6)} ${testEvent.currency}`);

        // Clean up test data
        await AdRevenueEvent.deleteOne({ _id: testEvent._id });
        console.log('✅ Test cleanup completed');

        await mongoose.disconnect();
        console.log('🎉 All tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testAdRevenueModel();
