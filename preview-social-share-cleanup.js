/**
 * DRY RUN - Preview what will be removed from articles
 * This script shows what changes would be made WITHOUT modifying the database
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

async function previewCleanup() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        console.log('🔍 Finding articles with social sharing text...');
        const articles = await Article.find({
            content: { $exists: true, $ne: '' }
        }).select('_id title content contentFormat');

        console.log(`📊 Checking ${articles.length} articles\n`);

        let matchCount = 0;
        const examples = [];

        for (const article of articles) {
            let originalContent = article.content;
            let cleanedContent = originalContent;
            let hasChanges = false;
            let matchedPatterns = [];

            // Apply all social sharing patterns
            for (let i = 0; i < SOCIAL_SHARE_PATTERNS.length; i++) {
                const pattern = SOCIAL_SHARE_PATTERNS[i];
                const beforeClean = cleanedContent;
                cleanedContent = cleanedContent.replace(pattern, '');
                if (beforeClean !== cleanedContent) {
                    hasChanges = true;
                    matchedPatterns.push(`Pattern ${i + 1}`);
                }
            }

            if (hasChanges) {
                matchCount++;

                // Store first 5 examples
                if (examples.length < 5) {
                    const excerpt = originalContent.substring(0, 200);
                    examples.push({
                        id: article._id,
                        title: article.title,
                        excerpt: excerpt,
                        patterns: matchedPatterns
                    });
                }
            }
        }

        console.log('📊 DRY RUN RESULTS:');
        console.log('==================\n');
        console.log(`✅ Found ${matchCount} articles with social sharing text`);
        console.log(`📝 Would update ${matchCount} articles\n`);

        if (examples.length > 0) {
            console.log('📄 Example Articles (first 5):');
            console.log('================================\n');
            examples.forEach((ex, idx) => {
                console.log(`${idx + 1}. "${ex.title}"`);
                console.log(`   ID: ${ex.id}`);
                console.log(`   Matched: ${ex.patterns.join(', ')}`);
                console.log(`   Excerpt: ${ex.excerpt}...`);
                console.log('');
            });
        }

        console.log('\n💡 To actually remove this text, run:');
        console.log('   node remove-social-share-text.js\n');

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the preview
console.log('🔍 DRY RUN - Preview Mode (No Changes Will Be Made)\n');
console.log('='.repeat(60) + '\n');
previewCleanup();
