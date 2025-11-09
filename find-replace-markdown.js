/**
 * Interactive Find and Replace Script for Markdown Articles
 * Allows searching and replacing text specifically in articles with contentFormat='markdown'
 * 
 * Usage:
 *   node find-replace-markdown.js
 * 
 * Then follow the prompts to enter:
 *   1. Text to find
 *   2. Replacement text (leave empty to remove the text)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const Article = require('./models/Article');

// Create readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Promisify readline question
function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function findReplaceMarkdown() {
    try {
        console.log('🚀 Interactive Find and Replace for Markdown Articles\n');
        console.log('=' .repeat(60) + '\n');

        // Get user input
        const findText = await question('📝 Enter text to FIND: ');
        
        if (!findText || findText.trim() === '') {
            console.log('❌ Error: Find text cannot be empty');
            rl.close();
            process.exit(1);
        }

        const replaceText = await question('📝 Enter REPLACEMENT text (press Enter to remove): ');
        
        console.log('\n' + '=' .repeat(60));
        console.log('📋 Summary:');
        console.log(`   Find: "${findText}"`);
        console.log(`   Replace with: "${replaceText || '[REMOVE]'}"`);
        console.log(`   Target: Articles with contentFormat='markdown'`);
        console.log('=' .repeat(60) + '\n');

        const confirm = await question('⚠️  Continue? This will modify your database. (yes/no): ');
        
        if (confirm.toLowerCase() !== 'yes') {
            console.log('❌ Operation cancelled');
            rl.close();
            process.exit(0);
        }

        console.log('\n🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Find markdown articles containing the text
        console.log('🔍 Searching for markdown articles with the specified text...');
        
        const articles = await Article.find({
            content: { $exists: true, $ne: '' },
            contentFormat: 'markdown',
            content: { $regex: findText, $options: 'i' } // Case-insensitive search
        }).select('_id title content contentFormat');

        console.log(`📊 Found ${articles.length} markdown articles containing "${findText}"\n`);

        if (articles.length === 0) {
            console.log('✅ No articles to update. Exiting...');
            rl.close();
            await mongoose.disconnect();
            return;
        }

        // Show first 5 examples
        if (articles.length > 0) {
            console.log('📄 Example articles (first 5):');
            articles.slice(0, 5).forEach((article, idx) => {
                console.log(`   ${idx + 1}. "${article.title}" (ID: ${article._id})`);
            });
            console.log('');
        }

        const finalConfirm = await question(`⚠️  Update ${articles.length} article(s)? (yes/no): `);
        
        if (finalConfirm.toLowerCase() !== 'yes') {
            console.log('❌ Operation cancelled');
            rl.close();
            await mongoose.disconnect();
            return;
        }

        rl.close(); // Close readline before processing

        console.log('\n🔄 Processing articles...\n');

        let updatedCount = 0;
        let skippedCount = 0;
        const batchSize = 100;

        // Create regex for case-insensitive replacement
        const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

        for (let i = 0; i < articles.length; i++) {
            const article = articles[i];
            const originalContent = article.content;
            
            // Replace all occurrences
            let newContent = originalContent.replace(regex, replaceText);

            if (newContent !== originalContent) {
                // Clean up extra spaces and line breaks
                newContent = newContent
                    .replace(/\n{3,}/g, '\n\n')    // Max 2 consecutive newlines
                    .replace(/[ \t]{2,}/g, ' ')     // Max 1 space
                    .trim();

                article.content = newContent;
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

        console.log('\n✅ Find and Replace Complete!');
        console.log('=' .repeat(60));
        console.log('📊 Statistics:');
        console.log(`   - Find text: "${findText}"`);
        console.log(`   - Replace with: "${replaceText || '[REMOVED]'}"`);
        console.log(`   - Total articles checked: ${articles.length}`);
        console.log(`   - Articles updated: ${updatedCount}`);
        console.log(`   - Articles skipped (no changes): ${skippedCount}`);
        console.log('=' .repeat(60) + '\n');

    } catch (error) {
        console.error('❌ Error:', error);
        rl.close();
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB\n');
    }
}

// Run the script
findReplaceMarkdown();
