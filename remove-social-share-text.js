/**
 * Script to remove social sharing text from article content
 * Removes patterns like "- Share on Facebook- Share on Messenger- Share on X- Share on Whatsapp"
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');

// Social sharing patterns to remove
const SOCIAL_SHARE_PATTERNS = [
    // Most common pattern
    /- Share on Facebook- Share on Messenger- Share on Messenger- Share on X- Share on WhatsApp/gi,
    /- Share on Facebook- Share on Messenger- Share on Messenger- Share on X- Share on Whatsapp/gi,
    // Variations
    /- Share on Facebook- Share on X- Share on WhatsApp/gi,
    /- Share on Facebook- Share on X- Share on Whatsapp/gi,
    /- Share on Facebook- Share on Messenger- Share on X/gi,
    // Without hyphens
    /Share on Facebook\s*Share on Messenger\s*Share on Messenger\s*Share on X\s*Share on WhatsApp/gi,
    /Share on Facebook\s*Share on Messenger\s*Share on Messenger\s*Share on X\s*Share on Whatsapp/gi,
    /Share on Facebook\s*Share on X\s*Share on WhatsApp/gi,
    /Share on Facebook\s*Share on X\s*Share on Whatsapp/gi,
];

async function cleanArticleContent() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Find all articles with content
        console.log('\n🔍 Finding articles with social sharing text...');
        const articles = await Article.find({
            content: { $exists: true, $ne: '' }
        }).select('_id title content contentFormat');

        console.log(`📊 Found ${articles.length} total articles to check`);

        let updatedCount = 0;
        let skippedCount = 0;
        const batchSize = 100;

        for (let i = 0; i < articles.length; i++) {
            const article = articles[i];
            let originalContent = article.content;
            let cleanedContent = originalContent;
            let hasChanges = false;

            // Apply all social sharing patterns
            for (const pattern of SOCIAL_SHARE_PATTERNS) {
                const beforeClean = cleanedContent;
                cleanedContent = cleanedContent.replace(pattern, '');
                if (beforeClean !== cleanedContent) {
                    hasChanges = true;
                }
            }

            // Clean up extra spaces and line breaks that might be left
            if (hasChanges) {
                cleanedContent = cleanedContent
                    .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
                    .replace(/[ \t]{2,}/g, ' ')   // Max 1 space
                    .trim();

                // Update the article
                article.content = cleanedContent;
                await article.save();
                updatedCount++;

                if (updatedCount % 10 === 0) {
                    console.log(`✅ Updated ${updatedCount} articles...`);
                }
            } else {
                skippedCount++;
            }

            // Progress indicator
            if ((i + 1) % batchSize === 0) {
                console.log(`📊 Progress: ${i + 1}/${articles.length} articles checked`);
            }
        }

        console.log('\n✅ Cleanup Complete!');
        console.log(`📊 Statistics:`);
        console.log(`   - Total articles checked: ${articles.length}`);
        console.log(`   - Articles updated: ${updatedCount}`);
        console.log(`   - Articles skipped (no changes): ${skippedCount}`);

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
    }
}

// Run the script
console.log('🚀 Starting social sharing text removal...\n');
cleanArticleContent();
