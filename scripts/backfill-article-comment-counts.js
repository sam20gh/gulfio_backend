/**
 * Backfill Article.commentCount from the Comment collection.
 *
 * commentCount is a denormalized counter maintained going forward by the
 * comment create/delete routes. Existing articles predate the counter, so this
 * one-time script computes the true count of top-level comments per article and
 * writes it in bulk.
 *
 * Usage: node scripts/backfill-article-comment-counts.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function backfillArticleCommentCounts() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to Mongo');

    const Article = require('../models/Article');
    const Comment = require('../models/Comment');

    // Count top-level article comments grouped by articleId (stored as a string).
    const grouped = await Comment.aggregate([
        { $match: { articleId: { $exists: true, $ne: null } } },
        { $group: { _id: '$articleId', count: { $sum: 1 } } },
    ]);

    console.log(`📊 Found comments across ${grouped.length} articles`);

    // 1) Reset every article to 0 so articles with no comments are correct too.
    const reset = await Article.updateMany(
        { commentCount: { $ne: 0 } },
        { $set: { commentCount: 0 } }
    );
    console.log(`🧹 Reset commentCount on ${reset.modifiedCount} articles`);

    // 2) Bulk-write the real counts. articleId strings that aren't valid
    //    ObjectIds (or point at deleted articles) are simply no-ops.
    const ops = grouped
        .filter((g) => mongoose.Types.ObjectId.isValid(g._id))
        .map((g) => ({
            updateOne: {
                filter: { _id: new mongoose.Types.ObjectId(g._id) },
                update: { $set: { commentCount: g.count } },
            },
        }));

    let modified = 0;
    const BATCH = 1000;
    for (let i = 0; i < ops.length; i += BATCH) {
        const res = await Article.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
        modified += res.modifiedCount || 0;
        console.log(`   …${Math.min(i + BATCH, ops.length)}/${ops.length} processed`);
    }

    console.log(`✅ Backfill complete — set commentCount on ${modified} articles`);
    await mongoose.disconnect();
    process.exit(0);
}

backfillArticleCommentCounts().catch((err) => {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
});
