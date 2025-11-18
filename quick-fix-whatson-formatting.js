#!/usr/bin/env node

/**
 * Quick fix for WhatsOn articles - fixes formatting issues in existing content without re-scraping
 * Fixes:
 * 1. Heading spacing (adds newline after headings that are merged with text)
 * 2. Instagram garbage divs (converts to simple markdown links)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const Article = require('./models/Article');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

function fixContent(content) {
    let fixed = content;
    let changes = [];
    
    // Fix 1: Add newline after headings that are merged with text
    // Pattern: heading ends with lowercase immediately followed by uppercase (camelCase)
    
    // Fix h2 headings
    const h2Before = fixed;
    fixed = fixed.replace(/^(## [^\n]+[a-z])([A-Z][a-z])/gm, '$1\n\n$2');
    if (fixed !== h2Before) {
        changes.push('Fixed H2 spacing');
    }
    
    // Fix h3 headings
    const h3Before = fixed;
    fixed = fixed.replace(/^(### [^\n]+[a-z])([A-Z][a-z])/gm, '$1\n\n$2');
    if (fixed !== h3Before) {
        changes.push('Fixed H3 spacing');
    }
    
    // Fix 2: Replace Instagram garbage blockquotes with simple markdown links
    const instagramBlockquotePattern = /<blockquote class="instagram-media">[\s\S]*?<a href="(https:\/\/www\.instagram\.com\/[^"]+)"[^>]*>A post shared by ([^(]+)\(([^)]+)\)<\/a>[\s\S]*?<\/blockquote>/g;
    
    let match;
    const igBefore = fixed;
    while ((match = instagramBlockquotePattern.exec(content)) !== null) {
        const fullMatch = match[0];
        const url = match[1];
        const author = match[2].trim();
        const handle = match[3].trim();
        
        const replacement = `[📸 Instagram: ${author} (${handle})](${url})`;
        fixed = fixed.replace(fullMatch, replacement);
    }
    if (fixed !== igBefore) {
        changes.push('Fixed Instagram embed');
    }
    
    // Fix 3: Clean up excessive newlines (but preserve intentional spacing)
    fixed = fixed.replace(/\n{4,}/g, '\n\n\n');
    
    return { fixed, changes };
}

async function quickFix() {
    try {
        console.log('🔧 Quick Fix for WhatsOn Markdown Articles\n');
        console.log('This will fix heading spacing and Instagram embeds WITHOUT re-scraping.\n');
        
        const confirm = await question('⚠️  Continue? This will modify your database. (yes/no): ');
        
        if (confirm.toLowerCase() !== 'yes') {
            console.log('❌ Operation cancelled');
            rl.close();
            process.exit(0);
        }
        
        console.log('\n🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');
        
        // Get all WhatsOn markdown articles
        console.log('📊 Fetching WhatsOn markdown articles...');
        const articles = await Article.find({
            sourceId: '689f40bfdc962f8a4c8af2dc',
            contentFormat: 'markdown'
        }).select('_id title content');
        
        console.log(`📋 Found ${articles.length} articles to process\n`);
        
        let fixedCount = 0;
        let unchangedCount = 0;
        
        for (let i = 0; i < articles.length; i++) {
            const article = articles[i];
            const progress = `[${i + 1}/${articles.length}]`;
            
            const { fixed, changes } = fixContent(article.content);
            
            if (fixed !== article.content) {
                article.content = fixed;
                await article.save();
                fixedCount++;
                console.log(`${progress} ✅ Fixed: ${article.title.substring(0, 50)}... (${changes.join(', ')})`);
            } else {
                unchangedCount++;
                if (unchangedCount <= 5) {
                    console.log(`${progress} ⏭️  Unchanged: ${article.title.substring(0, 50)}...`);
                }
            }
        }
        
        console.log('\n=== SUMMARY ===');
        console.log(`✅ Fixed: ${fixedCount}`);
        console.log(`⏭️  Unchanged: ${unchangedCount}`);
        console.log(`📊 Total: ${articles.length}`);
        
        rl.close();
        await mongoose.disconnect();
        console.log('\n✅ Process complete');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        rl.close();
        await mongoose.disconnect();
        process.exit(1);
    }
}

quickFix();
