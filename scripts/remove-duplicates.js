#!/usr/bin/env node

/**
 * Script to remove duplicate articles from the database
 * This should be run after updating the scraper to fix duplicate issues
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Article = require('../models/Article');

async function removeDuplicates() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        console.log('🔍 Finding duplicate URLs...');

        // Find duplicate URLs
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

        console.log(`📊 Found ${urlDuplicates.length} URLs with duplicates`);

        let removedCount = 0;
        for (const duplicate of urlDuplicates) {
            // Keep the most recent article, remove older ones
            const sortedDocs = duplicate.docs.sort((a, b) =>
                new Date(b.publishedAt) - new Date(a.publishedAt)
            );

            // Remove all but the first (most recent)
            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Article.deleteMany({ _id: { $in: idsToRemove } });
                removedCount += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} duplicates for URL: ${duplicate._id}`);
            }
        }

        console.log('🔍 Finding duplicate titles from same source...');

        // Find duplicate titles from the same source
        const titleDuplicates = await Article.aggregate([
            {
                $match: {
                    title: { $exists: true, $ne: null, $ne: '' },
                    sourceId: { $exists: true, $ne: null }
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

        console.log(`📊 Found ${titleDuplicates.length} title+source combinations with duplicates`);

        for (const duplicate of titleDuplicates) {
            // Keep the most recent article, remove older ones
            const sortedDocs = duplicate.docs.sort((a, b) =>
                new Date(b.publishedAt) - new Date(a.publishedAt)
            );

            // Remove all but the first (most recent)
            const toRemove = sortedDocs.slice(1);
            const idsToRemove = toRemove.map(doc => doc.id);

            if (idsToRemove.length > 0) {
                await Article.deleteMany({ _id: { $in: idsToRemove } });
                removedCount += idsToRemove.length;
                console.log(`🗑️ Removed ${idsToRemove.length} duplicates for title: "${duplicate._id.title.slice(0, 50)}..."`);
            }
        }

        console.log(`✅ Cleanup completed. Removed ${removedCount} duplicate articles total.`);

        // Get final article count
        const finalCount = await Article.countDocuments();
        console.log(`📊 Final article count: ${finalCount}`);

    } catch (error) {
        console.error('❌ Error removing duplicates:', error);
    } finally {
        await mongoose.connection.close();
        console.log('🔐 Database connection closed');
        process.exit(0);
    }
}

// Run if called directly
if (require.main === module) {
    removeDuplicates();
}

module.exports = removeDuplicates;
