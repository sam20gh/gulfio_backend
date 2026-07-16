const express = require('express');
const router = express.Router();
const sendExpoNotification = require('../utils/sendExpoNotification');
const NotificationService = require('../utils/notificationService');
const auth = require('../middleware/auth'); // Keep auth for other routes
const User = require('../models/User');
const Article = require('../models/Article'); // Import Article model
const Reel = require('../models/Reel'); // Import Reel model
const Source = require('../models/Source'); // Import Source model
const UserActivity = require('../models/UserActivity'); // Import UserActivity model
const mongoose = require('mongoose');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const PointsService = require('../services/pointsService'); // 🎮 Gamification
const { getTreatmentForUser } = require('../utils/experiments'); // P3-1
const { invalidateDashboardSummary } = require('../utils/dashboardCache');
// Removed updateUserProfileEmbedding - now handled by daily cron job

function validateObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// Like/Dislike Article

router.post('/article/:id/like', auth, ensureMongoUser, async (req, res) => {
    const articleId = req.params.id;
    const { action } = req.body; // 'like' or 'dislike'

    if (!validateObjectId(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    // req.mongoUser is a lean object, so we need to fetch the actual document for save()
    const user = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);
    const isLiked = user.liked_articles.some(id => id.equals(articleObjectId));
    const isDisliked = user.disliked_articles?.some(id => id.equals(articleObjectId));

    // Check if this is a new like for notification purposes
    const wasNotLiked = !isLiked;

    if (action === 'like') {
        if (!isLiked) user.liked_articles.push(articleObjectId);
        if (isDisliked) user.disliked_articles.pull(articleObjectId);
    } else if (action === 'dislike') {
        if (!isDisliked) {
            user.disliked_articles = user.disliked_articles || [];
            user.disliked_articles.push(articleObjectId);
        }
        if (isLiked) user.liked_articles.pull(articleObjectId);
    } else {
        return res.status(400).json({ message: 'Invalid action type' });
    }

    await user.save();

    // Update article like/dislike counts in the database
    const article = await Article.findById(articleObjectId);
    if (article) {
        // Count total likes and dislikes for this article from all users
        const totalLikes = await User.countDocuments({ liked_articles: articleObjectId });
        const totalDislikes = await User.countDocuments({ disliked_articles: articleObjectId });

        // Update the article with the new counts
        article.likes = totalLikes;
        article.dislikes = totalDislikes;
        await article.save();
    }

    // Log activity for daily embedding update (non-blocking) + A/B treatment (P3-1)
    UserActivity.create({
        userId: user.supabase_id,
        eventType: action, // 'like' or 'dislike'
        articleId: articleObjectId,
        contentType: 'article', // Specify content type
        timestamp: new Date(),
        treatment: getTreatmentForUser(user.supabase_id),
    }).catch(err => console.error('⚠️ Failed to log activity:', err.message));

    // 🎮 Award points for liking (non-blocking)
    if (action === 'like' && wasNotLiked) {
        PointsService.awardPoints(user.supabase_id, 'ARTICLE_LIKE', {
            articleId: articleObjectId,
            category: article?.category
        }).catch(err => console.error('⚠️ Failed to award like points:', err.message));
    }

    // Send notification if this is a new like
    if (action === 'like' && wasNotLiked) {
        try {
            if (article && article.userId && article.userId !== user.supabase_id) {
                const likerName = user.name || user.email || 'Someone';
                await NotificationService.sendArticleLikeNotification(
                    article.userId,
                    user.supabase_id,
                    likerName,
                    articleId,
                    article.title
                );
            }
        } catch (notificationError) {
            console.error('Error sending article like notification:', notificationError);
            // Don't fail the request if notification fails
        }
    }

    // liked_count / disliked_count changed — drop the cached dashboard summary.
    invalidateDashboardSummary(user.supabase_id);

    res.json({
        liked_articles: user.liked_articles,
        disliked_articles: user.disliked_articles || [],
        article: article ? {
            likes: article.likes,
            dislikes: article.dislikes
        } : null
    });
});

// Mark Article as Viewed (Now just increments view count)
// Removed auth and ensureMongoUser middleware
router.post('/article/:articleId/view', async (req, res) => {
    const { articleId } = req.params;

    // Enhanced validation with detailed logging
    if (!articleId) {
        console.error('❌ View tracking: articleId is missing');
        return res.status(400).json({ message: 'Article ID is required' });
    }

    // Validate ObjectId format
    if (!validateObjectId(articleId)) {
        console.error('❌ View tracking: Invalid article ID format:', articleId);
        return res.status(400).json({ message: 'Invalid article ID format' });
    }

    try {
        // Convert to ObjectId explicitly to avoid string comparison issues
        const articleObjectId = new mongoose.Types.ObjectId(articleId);

        // Find the article and increment its view count
        const updatedArticle = await Article.findByIdAndUpdate(
            articleObjectId,
            { $inc: { viewCount: 1 } }, // Increment the viewCount field
            { new: true, select: 'viewCount' } // Return only the viewCount for performance
        );

        if (!updatedArticle) {
            console.error('❌ View tracking: Article not found:', articleId);
            return res.status(404).json({ message: 'Article not found' });
        }

        console.log(`✅ View tracked for article ${articleId}, new count: ${updatedArticle.viewCount}`);

        // Log activity for daily embedding update (optional - try to get userId from token if available)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.split(' ')[1];
                const { createClient } = require('@supabase/supabase-js');
                const supabase = createClient(
                    process.env.SUPABASE_URL,
                    process.env.SUPABASE_SERVICE_ROLE_KEY
                );
                const { data: { user } } = await supabase.auth.getUser(token);
                if (user) {
                    UserActivity.create({
                        userId: user.id,
                        eventType: 'view',
                        articleId: articleObjectId,
                        contentType: 'article', // Specify content type
                        timestamp: new Date(),
                        treatment: getTreatmentForUser(user.id), // P3-1
                    }).catch(err => console.error('⚠️ Failed to log view activity:', err.message));

                    // 🎮 Award points for reading article (non-blocking)
                    // Get article category for category-specific badges
                    Article.findById(articleObjectId).select('category').lean().then(art => {
                        PointsService.awardPoints(user.id, 'ARTICLE_READ', {
                            articleId: articleObjectId,
                            category: art?.category
                        }).catch(err => console.error('⚠️ Failed to award read points:', err.message));
                    }).catch(() => {
                        // Award without category if article lookup fails
                        PointsService.awardPoints(user.id, 'ARTICLE_READ', {
                            articleId: articleObjectId
                        }).catch(err => console.error('⚠️ Failed to award read points:', err.message));
                    });
                }
            } catch (err) {
                // Silent fail - view tracking still works without activity logging
            }
        }

        // Return success message and the new view count
        res.json({
            message: 'Article view count incremented',
            viewCount: updatedArticle.viewCount,
            success: true
        });

    } catch (err) {
        console.error('❌ Error incrementing article view count:', err);
        console.error('❌ Article ID that caused error:', articleId);
        console.error('❌ Error details:', {
            name: err.name,
            message: err.message,
            stack: err.stack?.split('\n').slice(0, 3).join('\n')
        });
        res.status(500).json({
            message: 'Error updating article view count',
            error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
        });
    }
});

// Save/Unsave Article (Requires auth and ensureMongoUser)
router.post('/article/:id/save', auth, ensureMongoUser, async (req, res) => {
    const articleId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    try {
        // req.mongoUser is a lean object, so we need to fetch the actual document for save()
        const user = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isSaved = user.saved_articles.some(id => id.equals(articleObjectId));

        if (isSaved) {
            user.saved_articles.pull(articleObjectId);
        } else {
            user.saved_articles.addToSet(articleObjectId);
        }

        await user.save();

        // Log activity for daily embedding update (non-blocking)
        UserActivity.create({
            userId: user.supabase_id,
            eventType: isSaved ? 'unsave' : 'save',
            articleId: articleObjectId,
            contentType: 'article', // Specify content type
            timestamp: new Date()
        }).catch(err => console.error('⚠️ Failed to log save activity:', err.message));

        // 🎮 Award points for saving article (only when saving, not unsaving)
        if (!isSaved) {
            const article = await Article.findById(articleObjectId).select('category').lean();
            PointsService.awardPoints(user.supabase_id, 'ARTICLE_SAVE', {
                articleId: articleObjectId,
                category: article?.category
            }).catch(err => console.error('⚠️ Failed to award save points:', err.message));
        }

        // saved_count changed — drop the cached dashboard summary.
        invalidateDashboardSummary(user.supabase_id);

        res.json({
            isSaved: !isSaved,
            saved_articles: user.saved_articles,
        });
    } catch (err) {
        console.error('Error saving/unsaving article:', err);
        res.status(500).json({ message: 'Error saving/unsaving article' });
    }
});

// Save/Unsave Reel (Requires auth and ensureMongoUser)
router.post('/reel/:id/save', auth, ensureMongoUser, async (req, res) => {
    const reelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);

    try {
        // req.mongoUser is a lean object, so we need to fetch the actual document for save()
        const user = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isSaved = user.saved_reels?.some(id => id.equals(reelObjectId));

        if (isSaved) {
            user.saved_reels.pull(reelObjectId);
        } else {
            if (!user.saved_reels) user.saved_reels = [];
            user.saved_reels.addToSet(reelObjectId);
        }

        await user.save();

        // Note: Reel saves don't affect article embeddings, so no UserActivity log needed

        // saved_reels_count changed — drop the cached dashboard summary.
        invalidateDashboardSummary(user.supabase_id);

        res.json({
            isSaved: !isSaved,
            saved_reels: user.saved_reels,
        });
    } catch (err) {
        console.error('Error saving/unsaving reel:', err);
        res.status(500).json({ message: 'Error saving/unsaving reel' });
    }
});

// Follow/Unfollow Source (Requires auth and ensureMongoUser)
router.post('/source/:id/follow', auth, ensureMongoUser, async (req, res) => {
    const sourceId = req.params.id;

    if (!validateObjectId(sourceId)) return res.status(400).json({ message: 'Invalid source ID' });

    try {
        // req.mongoUser is a lean object, so we need to fetch the actual document for save()
        const user = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.following_sources.includes(sourceId)) {
            user.following_sources.pull(sourceId);
        } else {
            user.following_sources.push(sourceId);
        }

        await user.save();

        // Note: Source follows affect personalization but are tracked in User model,
        // not UserActivity. The daily cron job will pick up changes from User.following_sources

        // following_sources_count changed — drop the cached dashboard summary.
        invalidateDashboardSummary(user.supabase_id);

        res.json({ following_sources: user.following_sources });
    } catch (err) {
        console.error('Error following source:', err); // Log the error
        res.status(500).json({ message: 'Error following source' });
    }
});

// Follow/Block Another User (Requires auth and ensureMongoUser)
router.post('/:targetSupabaseId/action', auth, ensureMongoUser, async (req, res) => {
    try {
        // req.mongoUser is a lean object, so we need to fetch the actual document for save()
        const user = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const { targetSupabaseId } = req.params;

        // 1) Look up the target user first
        const targetUser = await User.findOne({ supabase_id: targetSupabaseId });
        if (!targetUser) {
            return res.status(404).json({ message: 'Target user not found' });
        }

        // 2) Now it’s safe to grab their Mongo _id
        const targetMongoId = targetUser._id;
        if (!targetMongoId || targetMongoId.equals(user._id)) {
            return res
                .status(400)
                .json({ message: 'Invalid target or cannot target yourself' });
        }

        // 3) Read the action and compute follow/block flags
        const { action } = req.body; // 'follow', 'unfollow', 'block', 'unblock'
        const targetIdStr = targetMongoId.toString();
        const isFollowing = user.following_users
            .some(id => id.toString() === targetIdStr);
        const isBlocked = user.blocked_users
            .some(id => id.toString() === targetIdStr);

        if (action === 'check-follow') {
            return res.status(200).json({
                isFollowing,
                isBlocked
            });
        }
        // 4) Capture prior follow state for notifications
        const wasFollowing = isFollowing;

        // 5) Apply follow/unfollow/block logic
        if (action === 'follow') {
            if (!isFollowing) user.following_users.push(targetMongoId);
            if (isBlocked) user.blocked_users.pull(targetMongoId);
        } else if (action === 'unfollow') {
            if (isFollowing) user.following_users.pull(targetMongoId);
        } else if (action === 'block') {
            if (!isBlocked) user.blocked_users.push(targetMongoId);
            if (isFollowing) user.following_users.pull(targetMongoId);
        } else if (action === 'unblock') {
            if (isBlocked) user.blocked_users.pull(targetMongoId);
        } else {
            return res.status(400).json({ message: 'Invalid action' });
        }

        // 6) Persist and respond
        await user.save();

        // Note: User follows/blocks don't directly affect article embeddings
        // The daily cron job will handle any necessary updates

        // A follow relationship change moves the actor's following_users_count
        // AND the target's followers_count — invalidate both cached summaries.
        if (action === 'follow' || action === 'unfollow' || action === 'block') {
            invalidateDashboardSummary(user.supabase_id);
            invalidateDashboardSummary(targetUser.supabase_id);
        }

        res.json({
            isFollowing: action === 'follow' ? true
                : action === 'unfollow' ? false
                    : isFollowing,
            isBlocked: action === 'block' ? true
                : action === 'unblock' ? false
                    : isBlocked,
        });

        // 7) Send notification if needed
        if (action === 'follow' && !wasFollowing) {
            try {
                const followerName = user.name || user.email || 'Someone';
                await NotificationService.sendNewFollowerNotification(
                    targetUser.supabase_id,
                    user.supabase_id,
                    followerName
                );
            } catch (notificationError) {
                console.error('Error sending follow notification:', notificationError);
                // Don't fail the request if notification fails
            }
        }

    } catch (err) {
        console.error('Error in follow/block route:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Lightweight follow-status read. The article page only needs this boolean —
// hitting /source/group/:groupName for it pays for the whole profile payload.
// ensureMongoUser already fetched the user, so this route does zero extra queries.
router.get('/source/follow-status/:groupName', auth, ensureMongoUser, (req, res) => {
    const isFollowing = (req.mongoUser.following_sources || []).includes(req.params.groupName);
    res.json({ isFollowing });
});

// Follow/Unfollow Source Group
// Accepts explicit intent: { groupName, follow: true|false }. Requests with
// intent are idempotent — retries and rapid taps converge on the intended
// state. Legacy clients that omit `follow` get the old toggle behaviour.
router.post('/source/follow-group', auth, ensureMongoUser, async (req, res) => {
    const { groupName, follow } = req.body;

    if (!groupName) return res.status(400).json({ message: 'groupName is required' });

    try {
        const sourceCount = await Source.countDocuments({ groupName });
        if (!sourceCount) return res.status(404).json({ message: 'No sources found for this group' });

        const shouldFollow = typeof follow === 'boolean'
            ? follow
            : !(req.mongoUser.following_sources || []).includes(groupName);

        // Atomic membership update ($addToSet/$pull) instead of the old
        // read-modify-write save(), which could clobber concurrent updates.
        // `new: false` returns the pre-update doc so we can tell whether
        // membership actually changed and only then move follower counters.
        const before = await User.findOneAndUpdate(
            { supabase_id: req.mongoUser.supabase_id },
            shouldFollow
                ? { $addToSet: { following_sources: groupName } }
                : { $pull: { following_sources: groupName } },
            { new: false }
        );

        if (!before) {
            return res.status(404).json({ message: 'User not found' });
        }

        const beforeList = before.following_sources || [];
        const wasFollowing = beforeList.includes(groupName);
        if (wasFollowing !== shouldFollow) {
            await Source.updateMany({ groupName }, { $inc: { followers: shouldFollow ? 1 : -1 } });
        }

        const following_sources = shouldFollow
            ? (wasFollowing ? beforeList : [...beforeList, groupName])
            : beforeList.filter((g) => g !== groupName);

        // Note: Source group follows affect personalization but are tracked in User model
        // The daily cron job will pick up changes from User.following_sources

        // following_sources_count changed — drop the cached dashboard summary.
        invalidateDashboardSummary(before.supabase_id);

        res.json({
            following_sources,
            action: shouldFollow ? "followed" : "unfollowed",
        });

    } catch (err) {
        console.error('Error following/unfollowing group:', err);
        res.status(500).json({ message: 'Error updating follow status' });
    }
});

/**
 * POST /api/user-actions/article/:id/share
 * Track article share for points
 */
router.post('/article/:id/share', auth, ensureMongoUser, async (req, res) => {
    const articleId = req.params.id;
    const { platform } = req.body; // 'twitter', 'facebook', 'whatsapp', 'copy', etc.
    const userId = req.mongoUser.supabase_id;

    if (!validateObjectId(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    try {
        const article = await Article.findById(articleId);
        if (!article) {
            return res.status(404).json({ message: 'Article not found' });
        }

        // Log the share activity
        await UserActivity.create({
            userId,
            eventType: 'share',
            articleId: new mongoose.Types.ObjectId(articleId),
            contentType: 'article',
            metadata: { platform: platform || 'unknown' },
            timestamp: new Date()
        });

        // Update article share count
        await Article.findByIdAndUpdate(articleId, { $inc: { shareCount: 1 } });

        // 🎮 Award points for sharing
        const pointsResult = await PointsService.awardPoints(userId, 'ARTICLE_SHARE', {
            articleId,
            category: article.category,
            platform
        });

        console.log(`✅ Share tracked for article ${articleId} by user ${userId}`);

        res.json({
            success: true,
            message: 'Share tracked successfully',
            points: pointsResult?.pointsAwarded || 0
        });

    } catch (err) {
        console.error('❌ Error tracking share:', err);
        res.status(500).json({ message: 'Failed to track share' });
    }
});

/**
 * POST /api/user-actions/reel/:id/share
 * Track reel share for points
 */
router.post('/reel/:id/share', auth, ensureMongoUser, async (req, res) => {
    const reelId = req.params.id;
    const { platform } = req.body;
    const userId = req.mongoUser.supabase_id;

    if (!validateObjectId(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    try {
        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ message: 'Reel not found' });
        }

        // Log the share activity
        await UserActivity.create({
            userId,
            eventType: 'share',
            reelId: new mongoose.Types.ObjectId(reelId),
            contentType: 'reel',
            metadata: { platform: platform || 'unknown' },
            timestamp: new Date()
        });

        // Update reel share count
        await Reel.findByIdAndUpdate(reelId, { $inc: { shareCount: 1 } });

        // 🎮 Award points for sharing
        const pointsResult = await PointsService.awardPoints(userId, 'REEL_SHARE', {
            reelId,
            platform
        });

        console.log(`✅ Reel share tracked for ${reelId} by user ${userId}`);

        res.json({
            success: true,
            message: 'Share tracked successfully',
            points: pointsResult?.pointsAwarded || 0
        });

    } catch (err) {
        console.error('❌ Error tracking reel share:', err);
        res.status(500).json({ message: 'Failed to track share' });
    }
});


module.exports = router;