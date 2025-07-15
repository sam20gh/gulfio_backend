// utils/notificationService.js
const User = require('../models/User');
const sendExpoNotification = require('./sendExpoNotification');

/**
 * Comprehensive notification service that respects user notification settings
 */
class NotificationService {
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

            // Send the notification
            await sendExpoNotification(title, body, [user.pushToken], data, actions);
            console.log(`Notification sent to user ${userId} for type ${notificationType}`);
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
     * Extract mentioned users from text (looking for @username patterns)
     * @param {string} text - The text to scan for mentions
     * @returns {Array} Array of mentioned usernames
     */
    static extractMentions(text) {
        const mentionRegex = /@([a-zA-Z0-9_]+)/g;
        const mentions = [];
        let match;

        while ((match = mentionRegex.exec(text)) !== null) {
            mentions.push(match[1]);
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

        for (const username of mentions) {
            try {
                // Find user by username (you might need to adjust this based on your user model)
                const mentionedUser = await User.findOne({
                    $or: [
                        { name: username },
                        { email: { $regex: `^${username}@`, $options: 'i' } }
                    ]
                });

                if (mentionedUser && mentionedUser.supabase_id !== mentionerId) {
                    await this.sendMentionNotification(
                        mentionedUser.supabase_id,
                        mentionerId,
                        mentionerName,
                        context,
                        contextId,
                        articleId
                    );
                }
            } catch (error) {
                console.error(`Error sending mention notification for ${username}:`, error);
            }
        }
    }
}

module.exports = NotificationService;
