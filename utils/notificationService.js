// utils/notificationService.js
const User = require('../models/User');
const Notification = require('../models/Notification'); // Phase 3.3: Notification history
const sendExpoNotification = require('./sendExpoNotification');
const policy = require('./notificationPolicy');

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

            if (!user.pushToken) {
                console.log(`No push token for user: ${userId}`);
                return false;
            }

            const tokens = [user.pushToken];

            // Check if the specific notification type is enabled (missing key = schema default)
            if (!policy.isTypeEnabled(user, notificationType)) {
                console.log(`Notification type ${notificationType} disabled for user: ${userId}`);
                return false;
            }

            // Broadcast (proactive) pushes go through the Phase 0 policy:
            // holdout cohort, quiet hours, and the rolling daily budget.
            // Transactional pushes (replies, likes, mentions, follows) are
            // user-earned and skip this.
            if (policy.isBroadcastSetting(notificationType)) {
                const isBreaking = notificationType === 'breakingNews';
                const { eligible, skipped } = await policy.filterBroadcastEligible([user], {
                    bypassQuietHours: isBreaking,
                    bypassBudget: isBreaking,
                });
                if (!eligible.length) {
                    console.log(`Broadcast push to ${userId} blocked by policy:`, skipped);
                    return false;
                }
            }

            // Send the push notification
            await sendExpoNotification(title, body, tokens, data, actions);
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

            // Phase 0: hard cap — max 2 distinct breaking blasts per 7 days,
            // and never the same article twice. Breaking news only stays
            // credible if it is rare.
            const cap = await policy.canSendBreakingBlast(article._id);
            if (!cap.allowed) {
                console.warn(`🚫 Breaking news blast blocked (${cap.reason}); ${cap.recentCount} blasts in last 7 days`);
                return { totalSent: 0, totalFailed: 0, blocked: cap.reason };
            }

            // Get all users with push tokens and breaking news enabled
            const users = await User.find({
                pushToken: { $exists: true, $ne: null },
                'notificationSettings.breakingNews': { $ne: false },
            }).select('pushToken supabase_id city');

            if (!users.length) {
                console.log('⚠️ No users with push tokens found');
                return { totalSent: 0, totalFailed: 0 };
            }

            // Breaking news bypasses quiet hours and the daily budget by
            // design, but the holdout cohort still never receives it.
            const { eligible, skipped } = await policy.filterBroadcastEligible(users, {
                bypassQuietHours: true,
                bypassBudget: true,
            });

            const allTokens = eligible.map(u => u.pushToken);

            if (!allTokens.length) {
                console.log('⚠️ No eligible users after policy filtering', skipped);
                return { totalSent: 0, totalFailed: 0 };
            }

            console.log(`📤 Sending breaking news to ${allTokens.length} devices (skipped: ${JSON.stringify(skipped)})`);

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
            console.log(`💾 Saving breaking news notifications to database for ${eligible.length} users...`);
            await Promise.allSettled(
                eligible.map((user) =>
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
                usersReached: eligible.length,
            };
        } catch (error) {
            console.error('❌ Error in sendBreakingNewsToAllUsers:', error);
            return { totalSent: 0, totalFailed: 0, error: error.message };
        }
    }

    /**
     * Phase 0 replacement for the per-scrape "sample article" blast.
     * Sends at most ONE news push per ~day globally, and each recipient is
     * filtered through the broadcast policy (holdout, quiet hours, budget).
     * Saves history docs so the budget and open-rate tracking work.
     *
     * @param {Object} article - A representative new article (title, content, _id, image)
     * @param {number} totalNew - Number of new articles found in this scrape run
     * @returns {Object} { sent, skippedReason?, skipped? }
     */
    static async sendNewArticlesDigest(article, totalNew = 1) {
        try {
            if (!article || !article._id) {
                return { sent: 0, skippedReason: 'no_article' };
            }

            // Global once-per-day gate: if a 'news' push went out in the last
            // 20h (any user), do nothing. Quiet-hour skips don't create
            // history docs, so an early-morning scrape run doesn't burn the
            // day's send — the next daytime run picks it up.
            if (await policy.wasBroadcastSentRecently('news', 20)) {
                console.log('📵 News digest already sent in the last 20h — skipping');
                return { sent: 0, skippedReason: 'already_sent_today' };
            }

            const users = await User.find({
                pushToken: { $exists: true, $ne: null },
            }).select('pushToken supabase_id city notificationSettings');

            const optedIn = users.filter(u => policy.isTypeEnabled(u, 'newsNotifications'));
            const { eligible, skipped } = await policy.filterBroadcastEligible(optedIn);

            if (!eligible.length) {
                console.log('📵 No eligible users for news digest', skipped);
                return { sent: 0, skippedReason: 'no_eligible_users', skipped };
            }

            const content = article.content || '';
            const snippet = content.length > 140
                ? content.slice(0, 140).trim() + '…'
                : content || 'New articles are waiting for you';
            const title = article.title || 'New Article';
            const data = {
                type: 'news',
                articleId: article._id.toString(),
                totalNew,
                link: `gulfio://article/${article._id}`,
                imageUrl: article.image && article.image[0],
            };

            await sendExpoNotification(title, snippet, eligible.map(u => u.pushToken), data, [
                { actionId: 'view', buttonTitle: 'Read Article' },
                { actionId: 'dismiss', buttonTitle: 'Dismiss' },
            ]);

            await Promise.allSettled(
                eligible.map(user =>
                    this.saveNotificationToDatabase(user.supabase_id, 'news', title, snippet, data)
                )
            );

            console.log(`📤 News digest sent to ${eligible.length} users (skipped: ${JSON.stringify(skipped)}) for ${totalNew} new articles`);
            return { sent: eligible.length, skipped };
        } catch (error) {
            console.error('❌ Error in sendNewArticlesDigest:', error);
            return { sent: 0, skippedReason: 'error', error: error.message };
        }
    }

    /**
     * Lotto result push, policy-filtered. Previously lotto senders blasted
     * every user with a token and ignored notification settings entirely.
     * Gated behind the newsNotifications setting and counted against the
     * daily broadcast budget as type 'lotto'.
     *
     * @param {Object} result - Lotto result (drawNumber, numbers, specialNumber, prizeTiers, raffles, totalWinners)
     * @returns {Object} { sent, skippedReason?, skipped? }
     */
    static async sendLottoResultNotification(result) {
        try {
            if (!result || result.drawNumber == null) {
                return { sent: 0, skippedReason: 'no_result' };
            }

            // Never announce the same draw twice (scrape + cron + manual route
            // can all fire for one draw).
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const already = await Notification.findOne({
                type: 'lotto',
                'data.drawNumber': result.drawNumber,
                createdAt: { $gte: since },
            }).select('_id').lean();
            if (already) {
                console.log(`📵 Lotto draw #${result.drawNumber} already announced — skipping`);
                return { sent: 0, skippedReason: 'already_sent_for_draw' };
            }

            const users = await User.find({
                pushToken: { $exists: true, $ne: null },
            }).select('pushToken supabase_id city notificationSettings');

            const optedIn = users.filter(u => policy.isTypeEnabled(u, 'newsNotifications'));
            const { eligible, skipped } = await policy.filterBroadcastEligible(optedIn);

            if (!eligible.length) {
                console.log('📵 No eligible users for lotto notification', skipped);
                return { sent: 0, skippedReason: 'no_eligible_users', skipped };
            }

            const title = `UAE Lotto Draw #${result.drawNumber} Results`;
            const body = `Numbers: ${result.numbers.join(', ')} | Special: ${result.specialNumber} | Jackpot: ${result.prizeTiers?.[0]?.prize || ''}`;
            const data = {
                type: 'lotto',
                drawNumber: result.drawNumber,
                link: `gulfio://lotto/${result.drawNumber}`,
                numbers: result.numbers,
                specialNumber: result.specialNumber,
                prizeTiers: result.prizeTiers,
                raffles: result.raffles,
                totalWinners: result.totalWinners,
            };

            await sendExpoNotification(title, body, eligible.map(u => u.pushToken), data);

            await Promise.allSettled(
                eligible.map(user =>
                    this.saveNotificationToDatabase(user.supabase_id, 'lotto', title, body, data)
                )
            );

            console.log(`📤 Lotto notification sent to ${eligible.length} users (skipped: ${JSON.stringify(skipped)}) for draw #${result.drawNumber}`);
            return { sent: eligible.length, skipped };
        } catch (error) {
            console.error('❌ Error in sendLottoResultNotification:', error);
            return { sent: 0, skippedReason: 'error', error: error.message };
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
