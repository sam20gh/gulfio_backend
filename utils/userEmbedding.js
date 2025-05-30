const { getDeepSeekEmbedding } = require('./deepseek');
const User = require('../models/User');
const Article = require('../models/Article');

/**
 * Update a user's embedding profile based on their activities.
 * @param {String} userId - The user's MongoDB _id or supabase_id
 * @returns {Promise<void>}
 */
async function updateUserProfileEmbedding(userId) {
    // Fetch the user
    const user = await User.findById(userId) || await User.findOne({ supabase_id: userId });
    if (!user) throw new Error('User not found');

    // Get recent "liked" and "read" articles (expand logic as you like)
    const likedIds = user.liked_articles || [];
    const readIds = user.viewed_articles || [];
    const allIds = [...new Set([...likedIds, ...readIds])].slice(0, 20); // most recent 20

    if (!allIds.length) {
        user.embedding = []; // No activity? Reset embedding.
        await user.save();
        return;
    }

    const articles = await Article.find({ _id: { $in: allIds } }).sort({ publishedAt: -1 }).limit(20);

    // Combine titles & (optional) first 100 chars of content
    const profileText = articles
        .map(a => `${a.title} - ${a.content?.slice(0, 100) || ''}`)
        .join('\n');

    // Get embedding
    let embedding = [];
    try {
        embedding = await getDeepSeekEmbedding(profileText);
    } catch (err) {
        console.warn('DeepSeek embedding error for user:', err.message);
    }

    user.embedding = embedding;
    await user.save();
}

module.exports = { updateUserProfileEmbedding };
