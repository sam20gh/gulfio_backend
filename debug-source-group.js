const mongoose = require('mongoose');
const Source = require('./models/Source');
const Article = require('./models/Article');
const User = require('./models/User');
require('dotenv').config();

async function debugSourceGroup(groupName) {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        console.log('\n🔍 Debugging source group:', groupName);
        console.log('=' .repeat(50));

        // 1. Find sources for this group
        const sources = await Source.find({ groupName });
        console.log('\n📂 Sources found:', sources.length);
        sources.forEach(source => {
            console.log(`  - ${source.name} (ID: ${source._id}, Followers: ${source.followers})`);
        });

        if (sources.length === 0) {
            console.log('❌ No sources found for this group!');
            return;
        }

        // 2. Get source IDs
        const sourceIds = sources.map(source => source._id);
        console.log('\n🎯 Source IDs:', sourceIds);

        // 3. Count articles for these sources
        const totalArticleCount = await Article.countDocuments({ sourceId: { $in: sourceIds } });
        console.log('\n📄 Total articles found:', totalArticleCount);

        // 4. Get sample articles
        const sampleArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .limit(3)
            .select('title sourceId publishedAt');
        
        console.log('\n📋 Sample articles:');
        sampleArticles.forEach(article => {
            console.log(`  - "${article.title}" (Source: ${article.sourceId})`);
        });

        // 5. Check if there are any articles with different sourceId format
        const allArticles = await Article.find({}).limit(5).select('sourceId');
        console.log('\n🔍 Sample sourceId formats in database:');
        allArticles.forEach(article => {
            console.log(`  - ${article.sourceId} (Type: ${typeof article.sourceId})`);
        });

        // 6. Test a sample user's following_sources
        const sampleUser = await User.findOne({}).select('following_sources supabase_id');
        if (sampleUser) {
            console.log('\n👤 Sample user following_sources:', sampleUser.following_sources);
            console.log('   User supabase_id:', sampleUser.supabase_id);
            console.log('   Is following this group?', sampleUser.following_sources.includes(groupName));
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n✅ Disconnected from MongoDB');
    }
}

// Get groupName from command line args
const groupName = process.argv[2];
if (!groupName) {
    console.log('Usage: node debug-source-group.js <groupName>');
    console.log('Example: node debug-source-group.js "CNN"');
    process.exit(1);
}

debugSourceGroup(groupName);
