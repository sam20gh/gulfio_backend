/**
 * DRY RUN - Preview Find and Replace for Markdown Articles
 * Shows what would be changed WITHOUT actually modifying the database
 * 
 * Usage:
 *   node preview-find-replace-markdown.js
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

async function previewFindReplace() {
    try {
        console.log('🔍 DRY RUN - Preview Find and Replace for Markdown Articles\n');
        console.log('=' .repeat(60));
        console.log('⚠️  This is a PREVIEW ONLY - No changes will be made');
        console.log('=' .repeat(60) + '\n');

        // Get user input
        const findText = await question('📝 Enter text to FIND: ');
        
        if (!findText || findText.trim() === '') {
            console.log('❌ Error: Find text cannot be empty');
            rl.close();
            process.exit(1);
        }

        const replaceText = await question('📝 Enter REPLACEMENT text (press Enter to remove): ');
        
        rl.close();

        console.log('\n' + '=' .repeat(60));
        console.log('📋 Preview Summary:');
        console.log(`   Find: "${findText}"`);
        console.log(`   Replace with: "${replaceText || '[REMOVE]'}"`);
        console.log(`   Target: Articles with contentFormat='markdown'`);
        console.log('=' .repeat(60) + '\n');

        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Find markdown articles containing the text
        console.log('🔍 Searching for markdown articles with the specified text...');
        
        const articles = await Article.find({
            content: { $exists: true, $ne: '' },
            contentFormat: 'markdown',
            content: { $regex: findText, $options: 'i' } // Case-insensitive search
        }).select('_id title content contentFormat publishedAt');

        console.log(`📊 Found ${articles.length} markdown articles containing "${findText}"\n`);

        if (articles.length === 0) {
            console.log('✅ No articles match. Nothing would be updated.');
            await mongoose.disconnect();
            return;
        }

        // Count total markdown articles for context
        const totalMarkdown = await Article.countDocuments({ contentFormat: 'markdown' });
        console.log(`📄 Total markdown articles in database: ${totalMarkdown}`);
        console.log(`📄 Articles that would be updated: ${articles.length} (${((articles.length / totalMarkdown) * 100).toFixed(1)}%)\n`);

        // Show first 10 examples with excerpts
        console.log('📄 Example articles (first 10):');
        console.log('=' .repeat(60));
        
        const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        
        articles.slice(0, 10).forEach((article, idx) => {
            console.log(`\n${idx + 1}. "${article.title}"`);
            console.log(`   ID: ${article._id}`);
            console.log(`   Published: ${article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : 'N/A'}`);
            
            // Find and show context around the match
            const matchIndex = article.content.toLowerCase().indexOf(findText.toLowerCase());
            if (matchIndex !== -1) {
                const start = Math.max(0, matchIndex - 40);
                const end = Math.min(article.content.length, matchIndex + findText.length + 40);
                const excerpt = article.content.substring(start, end);
                console.log(`   Match: "...${excerpt}..."`);
                
                // Show what it would become
                const newExcerpt = excerpt.replace(regex, replaceText);
                console.log(`   Would become: "...${newExcerpt}..."`);
            }
        });

        console.log('\n' + '=' .repeat(60));
        console.log('📊 PREVIEW SUMMARY:');
        console.log('=' .repeat(60));
        console.log(`   Find text: "${findText}"`);
        console.log(`   Replace with: "${replaceText || '[REMOVED]'}"`);
        console.log(`   Articles that would be updated: ${articles.length}`);
        console.log(`   Total markdown articles: ${totalMarkdown}`);
        console.log('=' .repeat(60) + '\n');

        console.log('💡 To actually perform this replacement, run:');
        console.log('   node find-replace-markdown.js\n');

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
previewFindReplace();
