#!/usr/bin/env node

/**
 * Script to remove duplicate reels from the database based on caption similarity
 * Keeps the most recent reel by scrapedAt date and removes older duplicates
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Reel = require('../models/Reel');

// Helper function to normalize text for comparison
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .trim();
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

async function removeDuplicateReels() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        let totalRemoved = 0;

        // Step 1: Find exact caption duplicates
        console.log('🔍 Step 1: Finding exact caption duplicates...');
        const exactCaptionDuplicates = await Reel.aggregate([
            {
                $match: {
                    caption: { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: '$caption',
                    count: { $sum: 1 },
                    docs: { $push: { id: '$_id', scrapedAt: '$scrapedAt', publishedAt: '$publishedAt' } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        console.log(`📊 Found ${exactCaptionDuplicates.length} captions with exact duplicates`);

        for (const duplicate of exactCaptionDuplicates) {
            // Sort by scrapedAt or publishedAt (newest first)
            const sortedDocs = duplicate.docs.sort((a, b) => {
                const dateA = a.scrapedAt || a.publishedAt || new Date(0);
                const dateB = b.scrapedAt || b.publishedAt || new Date(0);
                return new Date(dateB) - new Date(dateA);
            });

            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Reel.deleteMany({ _id: { $in: idsToRemove } });
                totalRemoved += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} exact caption duplicates (kept newest)`);
            }
        }

        // Step 2: Find reels with empty captions
        console.log('🔍 Step 2: Checking for reels with empty captions...');
        const emptyCapationCount = await Reel.countDocuments({
            caption: { $exists: false }
        });
        console.log(`📊 Found ${emptyCapationCount} reels with empty/missing captions`);

        // Step 3: Find similar caption duplicates (normalized comparison)
        console.log('🔍 Step 3: Finding similar caption duplicates...');

        const reelsWithCaptions = await Reel.find({
            caption: { $exists: true, $ne: null, $ne: '' }
        }).select('_id caption scrapedAt publishedAt').lean();

        const normalizedCaptionGroups = new Map();

        for (const reel of reelsWithCaptions) {
            const normalizedCaption = normalizeText(reel.caption);
            if (normalizedCaption.length < 5) continue; // Skip very short captions

            if (!normalizedCaptionGroups.has(normalizedCaption)) {
                normalizedCaptionGroups.set(normalizedCaption, []);
            }
            normalizedCaptionGroups.get(normalizedCaption).push(reel);
        }

        let similarCaptionDuplicates = 0;
        for (const [normalizedCaption, reels] of normalizedCaptionGroups) {
            if (reels.length > 1) {
                // Sort by scrapedAt, keep the most recent
                const sortedReels = reels.sort((a, b) => {
                    const dateA = a.scrapedAt || a.publishedAt || new Date(0);
                    const dateB = b.scrapedAt || b.publishedAt || new Date(0);
                    return new Date(dateB) - new Date(dateA);
                });

                const toRemove = sortedReels.slice(1);
                const idsToRemove = toRemove.map(reel => reel._id);

                if (idsToRemove.length > 0) {
                    await Reel.deleteMany({ _id: { $in: idsToRemove } });
                    totalRemoved += idsToRemove.length;
                    similarCaptionDuplicates += idsToRemove.length;
                    console.log(`🗑️ Removed ${idsToRemove.length} similar caption duplicates for: "${normalizedCaption.slice(0, 50)}..."`);
                }
            }
        }

        console.log(`📊 Found and removed ${similarCaptionDuplicates} similar caption duplicates`);

        // Step 4: Find duplicate reelId entries (shouldn't happen but safety check)
        console.log('🔍 Step 4: Finding duplicate reelId entries...');
        const reelIdDuplicates = await Reel.aggregate([
            {
                $match: {
                    reelId: { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: '$reelId',
                    count: { $sum: 1 },
                    docs: { $push: { id: '$_id', scrapedAt: '$scrapedAt', publishedAt: '$publishedAt' } }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        console.log(`📊 Found ${reelIdDuplicates.length} reelIds with exact duplicates`);

        for (const duplicate of reelIdDuplicates) {
            const sortedDocs = duplicate.docs.sort((a, b) => {
                const dateA = a.scrapedAt || a.publishedAt || new Date(0);
                const dateB = b.scrapedAt || b.publishedAt || new Date(0);
                return new Date(dateB) - new Date(dateA);
            });

            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Reel.deleteMany({ _id: { $in: idsToRemove } });
                totalRemoved += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} duplicate reelIds (kept newest)`);
            }
        }

        const finalCount = await Reel.countDocuments();
        console.log(`✅ Cleanup completed. Removed ${totalRemoved} duplicate reels total.`);
        console.log(`📊 Final reel count: ${finalCount}`);

    } catch (error) {
        console.error('❌ Error removing duplicate reels:', error);
    } finally {
        console.log('🔐 Database connection closed');
        await mongoose.connection.close();
    }
}

// Run the script
removeDuplicateReels();
