#!/usr/bin/env node

/**
 * Optimized script to remove duplicate articles from the database
 * This version is much more efficient and won't hang on large datasets
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Article = require('../models/Article');

// Helper function to normalize text for comparison
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .trim();
}

// Helper function to normalize URLs
function normalizeUrl(url) {
    if (!url) return '';
    return url.toLowerCase().replace(/\/+$/, ''); // Remove trailing slashes
}

// Helper function to calculate Levenshtein distance similarity
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const matrix = [];
    const len1 = str1.length;
    const len2 = str2.length;

    // If one string is much longer than the other, they're not similar
    const lengthRatio = Math.min(len1, len2) / Math.max(len1, len2);
    if (lengthRatio < 0.7) return 0;

    // Initialize matrix
    for (let i = 0; i <= len1; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
        matrix[0][j] = j;
    }

    // Calculate distances
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    const maxLen = Math.max(len1, len2);
    return 1 - matrix[len1][len2] / maxLen;
}

async function removeDuplicates() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        let totalRemoved = 0;

        // Step 1: Find exact URL duplicates (most efficient)
        console.log('🔍 Step 1: Finding exact URL duplicates...');
        const urlDuplicates = await Article.aggregate([
            {
                $match: {
                    url: { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: '$url',
                    count: { $sum: 1 },
                    docs: { $push: { id: '$_id', publishedAt: '$publishedAt' } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        console.log(`📊 Found ${urlDuplicates.length} URLs with exact duplicates`);

        for (const duplicate of urlDuplicates) {
            const sortedDocs = duplicate.docs.sort((a, b) =>
                new Date(b.publishedAt) - new Date(a.publishedAt)
            );
            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Article.deleteMany({ _id: { $in: idsToRemove } });
                totalRemoved += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} exact URL duplicates`);
            }
        }

        // Step 2: Find exact title + source duplicates
        console.log('🔍 Step 2: Finding exact title+source duplicates...');
        const titleDuplicates = await Article.aggregate([
            {
                $match: {
                    title: { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: { title: '$title', sourceId: '$sourceId' },
                    count: { $sum: 1 },
                    docs: { $push: { id: '$_id', publishedAt: '$publishedAt' } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        console.log(`📊 Found ${titleDuplicates.length} title+source combinations with exact duplicates`);

        for (const duplicate of titleDuplicates) {
            const sortedDocs = duplicate.docs.sort((a, b) =>
                new Date(b.publishedAt) - new Date(a.publishedAt)
            );
            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Article.deleteMany({ _id: { $in: idsToRemove } });
                totalRemoved += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} exact title+source duplicates`);
            }
        }

        // Step 3: Find similar URL duplicates (URLs that differ only by trailing slashes, etc.)
        console.log('🔍 Step 3: Finding similar URL duplicates...');
        const allUrls = await Article.find({
            url: { $exists: true, $ne: null, $ne: '' }
        }).select('_id url publishedAt').lean();

        const urlGroups = new Map();

        for (const article of allUrls) {
            const normalizedUrl = normalizeUrl(article.url);
            if (!urlGroups.has(normalizedUrl)) {
                urlGroups.set(normalizedUrl, []);
            }
            urlGroups.get(normalizedUrl).push(article);
        }

        let similarUrlDuplicates = 0;
        for (const [normalizedUrl, articles] of urlGroups) {
            if (articles.length > 1) {
                // Sort by publishedAt, keep the most recent
                const sortedArticles = articles.sort((a, b) =>
                    new Date(b.publishedAt) - new Date(a.publishedAt)
                );
                const toRemove = sortedArticles.slice(1);
                const idsToRemove = toRemove.map(article => article._id);

                if (idsToRemove.length > 0) {
                    await Article.deleteMany({ _id: { $in: idsToRemove } });
                    totalRemoved += idsToRemove.length;
                    similarUrlDuplicates += idsToRemove.length;
                    console.log(`🗑️ Removed ${idsToRemove.length} similar URL duplicates for: ${normalizedUrl.slice(0, 60)}...`);
                }
            }
        }

        console.log(`📊 Found and removed ${similarUrlDuplicates} similar URL duplicates`);

        // Step 4: Find specific problematic articles (the ones you mentioned)
        console.log('🔍 Step 4: Finding specific similar content duplicates...');

        // Check for the specific articles you mentioned
        const specificIds = ['686968915b53edc2e9e52e45', '68c45326ab717fcb6674110a'];
        const specificArticles = await Article.find({
            _id: { $in: specificIds.map(id => new mongoose.Types.ObjectId(id)) }
        }).select('_id title url publishedAt content').lean();

        console.log(`📊 Found ${specificArticles.length} of the specific articles mentioned`);

        if (specificArticles.length === 2) {
            const [article1, article2] = specificArticles;
            const titleSimilarity = calculateSimilarity(
                normalizeText(article1.title),
                normalizeText(article2.title)
            );

            console.log(`📊 Title similarity: ${(titleSimilarity * 100).toFixed(1)}%`);
            console.log(`📊 Article 1 title: "${article1.title?.slice(0, 100)}..."`);
            console.log(`📊 Article 2 title: "${article2.title?.slice(0, 100)}..."`);

            if (titleSimilarity > 0.85) {
                // Keep the more recent one
                const toKeep = new Date(article1.publishedAt) > new Date(article2.publishedAt) ? article1 : article2;
                const toRemove = toKeep === article1 ? article2 : article1;

                await Article.deleteOne({ _id: toRemove._id });
                totalRemoved += 1;
                console.log(`🗑️ Removed similar article: ${toRemove._id} (kept more recent one: ${toKeep._id})`);
            }
        }

        // Step 5: Efficient similar title detection (using batched approach)
        console.log('🔍 Step 5: Finding similar title duplicates (batched)...');

        // Get articles with normalized titles for comparison
        const articlesWithTitles = await Article.find({
            title: { $exists: true, $ne: null, $ne: '' }
        }).select('_id title publishedAt sourceId').lean();

        // Group by normalized title first to reduce comparisons
        const normalizedTitleGroups = new Map();

        for (const article of articlesWithTitles) {
            const normalizedTitle = normalizeText(article.title);
            if (normalizedTitle.length < 10) continue; // Skip very short titles

            if (!normalizedTitleGroups.has(normalizedTitle)) {
                normalizedTitleGroups.set(normalizedTitle, []);
            }
            normalizedTitleGroups.get(normalizedTitle).push(article);
        }

        let similarTitleDuplicates = 0;
        for (const [normalizedTitle, articles] of normalizedTitleGroups) {
            if (articles.length > 1) {
                // Sort by publishedAt, keep the most recent
                const sortedArticles = articles.sort((a, b) =>
                    new Date(b.publishedAt) - new Date(a.publishedAt)
                );
                const toRemove = sortedArticles.slice(1);
                const idsToRemove = toRemove.map(article => article._id);

                if (idsToRemove.length > 0) {
                    await Article.deleteMany({ _id: { $in: idsToRemove } });
                    totalRemoved += idsToRemove.length;
                    similarTitleDuplicates += idsToRemove.length;
                    console.log(`🗑️ Removed ${idsToRemove.length} similar title duplicates`);
                }
            }
        }

        console.log(`📊 Found and removed ${similarTitleDuplicates} similar title duplicates`);

        const finalCount = await Article.countDocuments();
        console.log(`✅ Cleanup completed. Removed ${totalRemoved} duplicate articles total.`);
        console.log(`📊 Final article count: ${finalCount}`);

    } catch (error) {
        console.error('❌ Error removing duplicates:', error);
    } finally {
        console.log('🔐 Database connection closed');
        await mongoose.connection.close();
    }
}

// Run the script
removeDuplicates();
