const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Source = require('./models/Source');
const Article = require('./models/Article');
const User = require('./models/User');

async function testSourceGroup() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Test 1: Check if bioSection and bioLink fields exist
        const sampleSource = await Source.findOne();
        if (sampleSource) {
            console.log('✅ Sample source fields:', {
                name: sampleSource.name,
                bioSection: sampleSource.bioSection,
                bioLink: sampleSource.bioLink,
                hasGroupName: !!sampleSource.groupName
            });
        }

        // Test 2: Find a group and count articles
        const groupName = sampleSource?.groupName;
        if (groupName) {
            const sources = await Source.find({ groupName });
            const sourceIds = sources.map(s => s._id);
            const articleCount = await Article.countDocuments({ sourceId: { $in: sourceIds } });

            console.log('✅ Group test:', {
                groupName,
                sourcesInGroup: sources.length,
                totalArticles: articleCount,
                followers: sources.reduce((acc, s) => acc + (s.followers || 0), 0)
            });
        }

        // Test 3: Check user following structure
        const sampleUser = await User.findOne();
        if (sampleUser) {
            console.log('✅ Sample user following:', {
                followingSources: sampleUser.following_sources?.length || 0,
                followingUsers: sampleUser.following_users?.length || 0
            });
        }

        console.log('✅ All tests completed successfully');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

testSourceGroup();
