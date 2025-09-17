/**
 * Fix articles with future dates in the database
 * This script finds articles with dates beyond the current date and corrects them
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');

async function fixFutureDates() {
    try {
        console.log('🔧 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        const currentDate = new Date();
        console.log('📅 Current date:', currentDate.toISOString());

        // Find articles with future dates
        console.log('🔍 Finding articles with future dates...');
        const futureArticles = await Article.find({
            publishedAt: { $gt: currentDate }
        }).sort({ publishedAt: -1 });

        console.log(`📊 Found ${futureArticles.length} articles with future dates:`);

        if (futureArticles.length === 0) {
            console.log('✅ No articles with future dates found');
            process.exit(0);
        }

        // Show the problematic articles
        futureArticles.forEach((article, index) => {
            console.log(`${index + 1}. "${article.title?.substring(0, 60)}..." - Date: ${article.publishedAt.toISOString()}`);
        });

        console.log('\n🔧 Fixing future dates...');

        let fixedCount = 0;
        for (const article of futureArticles) {
            // Set the date to now if it's in the future
            const originalDate = article.publishedAt;
            article.publishedAt = currentDate;

            await article.save();
            fixedCount++;

            console.log(`✅ Fixed article "${article.title?.substring(0, 50)}..." - Old date: ${originalDate.toISOString()} -> New date: ${currentDate.toISOString()}`);
        }

        console.log(`\n🎉 Successfully fixed ${fixedCount} articles with future dates`);

        // Verify the fix
        console.log('\n🔍 Verifying fix - checking for remaining future dates...');
        const remainingFutureArticles = await Article.find({
            publishedAt: { $gt: currentDate }
        });

        if (remainingFutureArticles.length === 0) {
            console.log('✅ All future dates have been fixed!');
        } else {
            console.log(`⚠️ Warning: ${remainingFutureArticles.length} articles still have future dates`);
        }

        // Show the latest articles now
        console.log('\n📋 Latest 5 articles after fix:');
        const latestArticles = await Article.find({})
            .sort({ publishedAt: -1 })
            .limit(5)
            .select('title publishedAt sourceId');

        latestArticles.forEach((article, index) => {
            console.log(`${index + 1}. "${article.title?.substring(0, 60)}..." - Date: ${article.publishedAt.toISOString()}`);
        });

    } catch (error) {
        console.error('❌ Error fixing future dates:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔐 Disconnected from MongoDB');
        process.exit(0);
    }
}

fixFutureDates();
