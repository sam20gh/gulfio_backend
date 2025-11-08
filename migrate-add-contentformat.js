// Migration script to add contentFormat field to existing articles
// This ensures backward compatibility - all existing articles are marked as 'text' format

require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');

async function migrateContentFormat() {
    try {
        console.log('🔄 Starting contentFormat migration...');
        console.log('📊 Connecting to MongoDB...');
        
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 90000, // 90 seconds for large operations
            connectTimeoutMS: 30000,
        });
        console.log('✅ Connected to MongoDB\n');

        // Count articles without contentFormat field
        const articlesWithoutFormat = await Article.countDocuments({
            contentFormat: { $exists: false }
        });

        console.log(`📈 Found ${articlesWithoutFormat} articles without contentFormat field`);

        if (articlesWithoutFormat === 0) {
            console.log('✅ All articles already have contentFormat field. Nothing to migrate.');
            process.exit(0);
        }

        console.log(`🔧 Setting contentFormat='text' for ${articlesWithoutFormat} existing articles...`);
        console.log(`⏱️  Processing in batches of 5000 for better performance...\n`);

        // Process in batches to avoid timeout
        const batchSize = 5000;
        let processed = 0;

        while (processed < articlesWithoutFormat) {
            const batchStart = Date.now();
            console.log(`📦 Processing batch: ${processed + 1} to ${Math.min(processed + batchSize, articlesWithoutFormat)}...`);
            
            // Update batch of articles without contentFormat to 'text'
            const result = await Article.updateMany(
                { contentFormat: { $exists: false } },
                { $set: { contentFormat: 'text' } },
                { limit: batchSize }
            );

            processed += result.modifiedCount;
            const batchTime = ((Date.now() - batchStart) / 1000).toFixed(2);
            
            console.log(`   ✅ Modified ${result.modifiedCount} articles in ${batchTime}s (Total: ${processed}/${articlesWithoutFormat})`);

            // If no documents were modified, we're done
            if (result.modifiedCount === 0) {
                break;
            }

            // Small delay between batches to avoid overwhelming the database
            if (processed < articlesWithoutFormat) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log(`\n✅ Migration complete!`);
        console.log(`   - Total processed: ${processed} articles`);
        console.log(`   - All existing articles now have contentFormat='text'`);
        console.log(`   - New articles will be saved with contentFormat='markdown'\n`);

        // Verify migration
        const textArticles = await Article.countDocuments({ contentFormat: 'text' });
        const markdownArticles = await Article.countDocuments({ contentFormat: 'markdown' });
        const noFormat = await Article.countDocuments({ contentFormat: { $exists: false } });

        console.log(`📊 Final statistics:`);
        console.log(`   - Text format: ${textArticles} articles`);
        console.log(`   - Markdown format: ${markdownArticles} articles`);
        console.log(`   - No format field: ${noFormat} articles`);

        if (noFormat > 0) {
            console.warn(`⚠️  Warning: ${noFormat} articles still don't have contentFormat field`);
        } else {
            console.log(`✅ All articles have contentFormat field!`);
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

migrateContentFormat();
