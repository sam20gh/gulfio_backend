const UserActivity = require('../models/UserActivity');
const User = require('../models/User');
const { updateUserProfileEmbedding } = require('./userEmbedding');

/**
 * Log a user activity and update user embedding
 * @param {Object} data - Event data
 * @param {string} data.userId - User ID
 * @param {string} data.eventType - Type of event (view, like, dislike, save, read_time)
 * @param {string} data.articleId - Article ID
 * @param {number} [data.duration] - Duration in seconds (for read_time events)
 * @returns {Promise<void>}
 */
const logUserActivity = async (data) => {
    try {
        // Create activity record
        await UserActivity.create({
            userId: data.userId,
            eventType: data.eventType,
            articleId: data.articleId,
            duration: data.duration || null,
            timestamp: new Date()
        });

        // Find user and update viewed_articles if this is a "view" event
        if (data.eventType === 'view') {
            const user = await User.findById(data.userId) ||
                await User.findOne({ supabase_id: data.userId });

            if (user) {
                // Add to viewed_articles if not already there
                const viewed = user.viewed_articles || [];
                if (!viewed.includes(data.articleId)) {
                    user.viewed_articles = [data.articleId, ...viewed].slice(0, 100); // Keep last 100
                    await user.save();
                }
            }
        }

        // For all significant events, update embedding
        if (['view', 'like', 'dislike', 'save', 'unsave', 'read_time'].includes(data.eventType)) {
            // Get the MongoDB user
            const user = await User.findById(data.userId) ||
                await User.findOne({ supabase_id: data.userId });

            if (user) {
                await updateUserProfileEmbedding(user._id);
            }
        }
    } catch (error) {
        console.error('Error logging user activity:', error);
    }
};

module.exports = { logUserActivity };
