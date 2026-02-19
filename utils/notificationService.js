// utils/notificationService.js
const User = require('../models/User');
const Notification = require('../models/Notification'); // Phase 3.3: Notification history
const sendExpoNotification = require('./sendExpoNotification');

/**
 * Comprehensive notification service that respects user notification settings
 */
class NotificationService {
    /**
     * Save notification to database for in-app notification center (Phase 3.3)
     * @param {string} userId - Supabase user ID
     * @param {string} type - Notification type
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data
     */
    static async saveNotificationToDatabase(userId, type, title, body, data = {}) {
        try {
            await Notification.create({
                userId,
                type,
                title,
                body,
                data,
            });
        } catch (error) {
            console.error(`Error saving notification to database for ${userId}:`, error);
            // Don't throw - notification history is non-critical
        }
    }
    /**
     * Send notification to user if they have enabled the specific notification type
     * @param {string} userId - The user ID to send notification to
     * @param {string} notificationType - Type of notification (newFollowers, articleLikes, mentions, etc.)
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data to include
     * @param {Array} actions - Action buttons for the notification
     */
    static async sendNotificationToUser(userId, notificationType, title, body, data = {}, actions = []) {
        try {
            // Find the user and check their notification settings
            const user = await User.findOne({ supabase_id: userId });
            if (!user) {
                console.log(`User not found: ${userId}`);
                return false;
            }

            // Check if user has a push token
            if (!user.pushToken) {
                console.log(`No push token for user: ${userId}`);
                return false;
            }

            // Check if the specific notification type is enabled
            const notificationSettings = user.notificationSettings || {};
            if (!notificationSettings[notificationType]) {
                console.log(`Notification type ${notificationType} disabled for user: ${userId}`);
                return false;
            }

            // Send the push notification
            await sendExpoNotification(title, body, [user.pushToken], data, actions);
            console.log(`Notification sent to user ${userId} for type ${notificationType}`);

            // Save to database for notification history (Phase 3.3)
            await this.saveNotificationToDatabase(userId, data.type || notificationType, title, body, data);

            return true;
        } catch (error) {
            console.error(`Error sending notification to user ${userId}:`, error);
            return false;
        }
    }

    /**
     * Send notification when someone follows a user
     * @param {string} followedUserId - The user being followed
     * @param {string} followerUserId - The user who followed
     * @param {string} followerName - Name of the follower
     */
    static async sendNewFollowerNotification(followedUserId, followerUserId, followerName) {
        return await this.sendNotificationToUser(
            followedUserId,
            'newFollowers',
            'New Follower',
            `${followerName} started following you`,
            {
                type: 'new_follower',
                followerId: followerUserId,
                followerName: followerName,
                link: `gulfio://profile/${followerUserId}`
            }
        );
    }

    /**
     * Send notification when someone likes a user's comment
     * @param {string} commentAuthorId - The author of the comment
     * @param {string} likerId - The user who liked the comment
     * @param {string} likerName - Name of the person who liked
     * @param {string} commentId - ID of the comment
     * @param {string} articleId - ID of the article (if applicable)
     */
    static async sendCommentLikeNotification(commentAuthorId, likerId, likerName, commentId, articleId = null) {
        return await this.sendNotificationToUser(
            commentAuthorId,
            'userNotifications',
            'Comment Liked',
            `${likerName} liked your comment`,
            {
                type: 'comment_like',
                likerId: likerId,
                likerName: likerName,
                commentId: commentId,
                articleId: articleId,
                link: articleId ? `gulfio://article/${articleId}?comment=${commentId}` : `gulfio://comment/${commentId}`
            }
        );
    }

    /**
     * Send notification when someone replies to a user's comment
     * @param {string} commentAuthorId - The author of the original comment
     * @param {string} replierId - The user who replied
     * @param {string} replierName - Name of the person who replied
     * @param {string} replyText - The reply text (truncated)
     * @param {string} commentId - ID of the original comment
     * @param {string} articleId - ID of the article (if applicable)
     */
    static async sendCommentReplyNotification(commentAuthorId, replierId, replierName, replyText, commentId, articleId = null) {
        // Truncate reply text for notification
        const snippet = replyText.length > 100 ? `${replyText.slice(0, 100).trim()}…` : replyText;

        return await this.sendNotificationToUser(
            commentAuthorId,
            'userNotifications',
            'New Reply',
            `${replierName} replied to your comment: "${snippet}"`,
            {
                type: 'comment_reply',
                replierId: replierId,
                replierName: replierName,
                replyText: snippet,
                commentId: commentId,
                articleId: articleId,
                link: articleId ? `gulfio://article/${articleId}?comment=${commentId}` : `gulfio://comment/${commentId}`
            }
        );
    }

    /**
     * Send notification when someone likes a user's article
     * @param {string} articleAuthorId - The author of the article
     * @param {string} likerId - The user who liked the article
     * @param {string} likerName - Name of the person who liked
     * @param {string} articleId - ID of the article
     * @param {string} articleTitle - Title of the article
     */
    static async sendArticleLikeNotification(articleAuthorId, likerId, likerName, articleId, articleTitle) {
        return await this.sendNotificationToUser(
            articleAuthorId,
            'articleLikes',
            'Article Liked',
            `${likerName} liked your article: "${articleTitle}"`,
            {
                type: 'article_like',
                likerId: likerId,
                likerName: likerName,
                articleId: articleId,
                articleTitle: articleTitle,
                link: `gulfio://article/${articleId}`
            }
        );
    }

    /**
     * Send notification when someone mentions a user
     * @param {string} mentionedUserId - The user being mentioned
     * @param {string} mentionerId - The user who mentioned
     * @param {string} mentionerName - Name of the person who mentioned
     * @param {string} context - Context where the mention occurred
     * @param {string} contextId - ID of the context (comment, article, etc.)
     * @param {string} articleId - ID of the article (if applicable)
     */
    static async sendMentionNotification(mentionedUserId, mentionerId, mentionerName, context, contextId, articleId = null) {
        return await this.sendNotificationToUser(
            mentionedUserId,
            'mentions',
            'You were mentioned',
            `${mentionerName} mentioned you in a ${context}`,
            {
                type: 'mention',
                mentionerId: mentionerId,
                mentionerName: mentionerName,
                context: context,
                contextId: contextId,
                articleId: articleId,
                link: articleId ? `gulfio://article/${articleId}?comment=${contextId}` : `gulfio://comment/${contextId}`
            }
        );
    }

    /**
     * Send notification about breaking news
     * @param {string} userId - The user ID to send notification to
     * @param {string} title - Breaking news title
     * @param {string} body - Breaking news body
     * @param {string} articleId - ID of the breaking news article
     */
    static async sendBreakingNewsNotification(userId, title, body, articleId) {
        return await this.sendNotificationToUser(
            userId,
            'breakingNews',
            'Breaking News',
            `${title}: ${body}`,
            {
                type: 'breaking_news',
                articleId: articleId,
                link: `gulfio://article/${articleId}`
            }
        );
    }

    /**
     * Send notification about news from followed sources
     * @param {string} userId - The user ID to send notification to
     * @param {string} sourceName - Name of the source
     * @param {string} title - Article title
     * @param {string} articleId - ID of the article
     */
    static async sendFollowedSourceNotification(userId, sourceName, title, articleId) {
        return await this.sendNotificationToUser(
            userId,
            'followedSources',
            `New from ${sourceName}`,
            title,
            {
                type: 'followed_source',
                sourceName: sourceName,
                articleId: articleId,
                link: `gulfio://article/${articleId}`
            }
        );
    }

    /**
     * Send weekly digest notification
     * @param {string} userId - The user ID to send notification to
     * @param {string} title - Digest title
     * @param {string} body - Digest body
     * @param {Object} data - Additional digest data
     */
    static async sendWeeklyDigestNotification(userId, title, body, data = {}) {
        return await this.sendNotificationToUser(
            userId,
            'weeklyDigest',
            title,
            body,
            {
                type: 'weekly_digest',
                ...data
            }
        );
    }

    /**
     * Send general news notification
     * @param {string} userId - The user ID to send notification to
     * @param {string} title - News title
     * @param {string} body - News body
     * @param {string} articleId - ID of the article
     */
    static async sendNewsNotification(userId, title, body, articleId) {
        return await this.sendNotificationToUser(
            userId,
            'newsNotifications',
            title,
            body,
            {
                type: 'news',
                articleId: articleId,
                link: `gulfio://article/${articleId}`
            }
        );
    }

    /**
     * Send notification to multiple users
     * @param {Array} userIds - Array of user IDs
     * @param {string} notificationType - Type of notification
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data
     * @param {Array} actions - Action buttons
     */
    static async sendBulkNotification(userIds, notificationType, title, body, data = {}, actions = []) {
        const results = await Promise.allSettled(
            userIds.map(userId =>
                this.sendNotificationToUser(userId, notificationType, title, body, data, actions)
            )
        );

        const successful = results.filter(result => result.status === 'fulfilled' && result.value).length;
        const failed = results.length - successful;

        console.log(`Bulk notification results: ${successful} successful, ${failed} failed`);
        return { successful, failed };
    }

    /**
     * Send breaking news notification to ALL users (Phase 3.3)
     * @param {Object} article - Article document with title and _id
     * @returns {Object} { totalSent, totalFailed }
     */
    static async sendBreakingNewsToAllUsers(article) {
        try {
            console.log(`🔥 Sending breaking news to all users: ${article.title}`);

            // Get all users with push tokens and breaking news enabled
            const users = await User.find({
                $or: [
                    { pushToken: { $exists: true, $ne: null } }, // Legacy single token
                    { 'pushTokens.0': { $exists: true } }, // New multiple tokens array
                ],
                'notificationSettings.breakingNews': { $ne: false }, // Breaking news not explicitly disabled
            }).select('pushToken pushTokens notificationSettings');

            if (!users.length) {
                console.log('⚠️ No users with push tokens found');
                return { totalSent: 0, totalFailed: 0 };
            }

            // Collect all valid tokens
            const allTokens = [];
            users.forEach((user) => {
                // Add legacy pushToken if it exists
                if (user.pushToken) {
                    allTokens.push(user.pushToken);
                }
                // Add all tokens from pushTokens array
                if (user.pushTokens && user.pushTokens.length > 0) {
                    user.pushTokens.forEach((tokenObj) => {
                        if (tokenObj.token) {
                            allTokens.push(tokenObj.token);
                        }
                    });
                }
            });

            if (!allTokens.length) {
                console.log('⚠️ No valid push tokens found');
                return { totalSent: 0, totalFailed: 0 };
            }

            console.log(`📤 Sending breaking news to ${allTokens.length} devices across ${users.length} users`);

            // Send push notification to all tokens
            await sendExpoNotification(
                '🔥 BREAKING NEWS',
                article.title,
                allTokens,
                {
                    type: 'breaking_news',
                    articleId: article._id.toString(),
                    link: `gulfio://article/${article._id}`,
                },
                []
            );

            console.log(`✅ Breaking news push sent to ${allTokens.length} devices`);

            // Save to database for notification history (Phase 3.3)
            console.log(`💾 Saving breaking news notifications to database for ${users.length} users...`);
            await Promise.allSettled(
                users.map((user) =>
                    this.saveNotificationToDatabase(
                        user.supabase_id,
                        'breaking_news',
                        '🔥 BREAKING NEWS',
                        article.title,
                        {
                            type: 'breaking_news',
                            articleId: article._id.toString(),
                            link: `gulfio://article/${article._id}`,
                        }
                    )
                )
            );
            console.log(`✅ Breaking news notifications saved to database`);

            return {
                totalSent: allTokens.length,
                totalFailed: 0,
                usersReached: users.length,
            };
        } catch (error) {
            console.error('❌ Error in sendBreakingNewsToAllUsers:', error);
            return { totalSent: 0, totalFailed: 0, error: error.message };
        }
    }

    /**
     * Extract mentioned users from text (looking for @Username patterns)
     * Matches names starting with capital letters, supports multi-word names like "Gulf News"
     * @param {string} text - The text to scan for mentions
     * @returns {Array} Array of mentioned names
     */
    static extractMentions(text) {
        // Match @Name or @Multi Word Name (stops at lowercase word, punctuation, or another @)
        const mentionRegex = /@([A-Z][^\s@]*(?:\s+[A-Z][^\s@]*)*?)(?=\s+[a-z]|\s*$|\s*[.,!?]|\s+@)/g;
        const mentions = [];
        let match;

        while ((match = mentionRegex.exec(text)) !== null) {
            mentions.push(match[1].trim());
        }

        return mentions;
    }

    /**
     * Send mention notifications for all mentioned users in a text
     * @param {string} text - The text containing mentions
     * @param {string} mentionerId - The user who made the mention
     * @param {string} mentionerName - Name of the person who mentioned
     * @param {string} context - Context where the mention occurred (comment, reply, etc.)
     * @param {string} contextId - ID of the context
     * @param {string} articleId - ID of the article (if applicable)
     */
    static async sendMentionNotifications(text, mentionerId, mentionerName, context, contextId, articleId = null) {
        const mentions = this.extractMentions(text);

        for (const mentionName of mentions) {
            try {
                // Find user by name (case-insensitive)
                const mentionedUser = await User.findOne({
                    name: { $regex: `^${mentionName}$`, $options: 'i' }
                });

                if (mentionedUser && mentionedUser.supabase_id !== mentionerId) {
                    console.log(`📢 Sending mention notification to ${mentionedUser.name} (${mentionedUser.supabase_id})`);
                    await this.sendMentionNotification(
                        mentionedUser.supabase_id,
                        mentionerId,
                        mentionerName,
                        context,
                        contextId,
                        articleId
                    );
                } else if (!mentionedUser) {
                    console.log(`⚠️ User not found for mention: ${mentionName}`);
                } else {
                    console.log(`⏭️ Skipping self-mention for ${mentionName}`);
                }
            } catch (error) {
                console.error(`Error sending mention notification for ${mentionName}:`, error);
            }
        }
    }
}

module.exports = NotificationService;
