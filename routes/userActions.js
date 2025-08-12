const express = require('express');
const router = express.Router();
const sendExpoNotification = require('../utils/sendExpoNotification');
const NotificationService = require('../utils/notificationService');
const auth = require('../middleware/auth'); // Keep auth for other routes
const User = require('../models/User');
const Article = require('../models/Article'); // Import Article model
const Reel = require('../models/Reel'); // Import Reel model
const Source = require('../models/Source'); // Import Source model
const mongoose = require('mongoose');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');
// Keep ensureMongoUser for other routes

function validateObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// Like/Dislike Article

router.post('/article/:id/like', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const articleId = req.params.id;
    const { action } = req.body; // 'like' or 'dislike'

    if (!validateObjectId(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
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

    // Update user embedding after like/dislike action
    try {
        await updateUserProfileEmbedding(user._id);
    } catch (embeddingError) {
        console.error('Error updating user embedding:', embeddingError);
        // Don't fail the request if embedding update fails
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

    if (!validateObjectId(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    try {
        // Find the article and increment its view count
        const updatedArticle = await Article.findByIdAndUpdate(
            articleId,
            { $inc: { viewCount: 1 } }, // Increment the viewCount field
            { new: true } // Return the updated document
        );

        if (!updatedArticle) {
            return res.status(404).json({ message: 'Article not found' });
        }

        // Return success message and potentially the new view count
        res.json({ message: 'Article view count incremented', viewCount: updatedArticle.viewCount });

    } catch (err) {
        console.error('Error incrementing article view count:', err);
        res.status(500).json({ message: 'Error updating article view count' });
    }
});

// Save/Unsave Article (Requires auth and ensureMongoUser)
router.post('/article/:id/save', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const articleId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    try {
        const isSaved = user.saved_articles.some(id => id.equals(articleObjectId));

        if (isSaved) {
            user.saved_articles.pull(articleObjectId);
        } else {
            user.saved_articles.addToSet(articleObjectId);
        }

        await user.save();
        await updateUserProfileEmbedding(user._id);
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
    const user = req.mongoUser;
    const reelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);

    try {
        const isSaved = user.saved_reels?.some(id => id.equals(reelObjectId));

        if (isSaved) {
            user.saved_reels.pull(reelObjectId);
        } else {
            if (!user.saved_reels) user.saved_reels = [];
            user.saved_reels.addToSet(reelObjectId);
        }

        await user.save();
        await updateUserProfileEmbedding(user._id);
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
    const user = req.mongoUser; // Use ensureMongoUser result
    const sourceId = req.params.id;

    if (!validateObjectId(sourceId)) return res.status(400).json({ message: 'Invalid source ID' });

    try {
        // No need to find user again if ensureMongoUser is used
        // const user = await User.findOne({ supabase_id: userId });

        if (user.following_sources.includes(sourceId)) {
            user.following_sources.pull(sourceId);
        } else {
            user.following_sources.push(sourceId);
        }

        await user.save();

        // Update user embedding after following/unfollowing source
        try {
            await updateUserProfileEmbedding(user._id);
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        res.json({ following_sources: user.following_sources });
    } catch (err) {
        console.error('Error following source:', err); // Log the error
        res.status(500).json({ message: 'Error following source' });
    }
});

// Follow/Block Another User (Requires auth and ensureMongoUser)
router.post('/:targetSupabaseId/action', auth, ensureMongoUser, async (req, res) => {
    try {
        const user = req.mongoUser;
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

        // Update user embedding after follow/block action
        try {
            await updateUserProfileEmbedding(user._id);
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
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

// Follow/Unfollow Source Group
router.post('/source/follow-group', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const { groupName } = req.body;

    if (!groupName) return res.status(400).json({ message: 'groupName is required' });

    try {
        const sources = await Source.find({ groupName });

        if (!sources.length) return res.status(404).json({ message: 'No sources found for this group' });

        const isFollowing = user.following_sources.includes(groupName);

        if (isFollowing) {
            // Unfollow: Remove groupName from user's following_sources
            user.following_sources.pull(groupName);
            // Decrement followers for all sources in the group
            await Source.updateMany({ groupName }, { $inc: { followers: -1 } });
        } else {
            // Follow: Add groupName to user's following_sources
            user.following_sources.push(groupName);
            // Increment followers for all sources in the group
            await Source.updateMany({ groupName }, { $inc: { followers: 1 } });
        }

        await user.save();

        // Update user embedding after following/unfollowing source group
        try {
            await updateUserProfileEmbedding(user._id);
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        res.json({
            following_sources: user.following_sources,
            action: isFollowing ? "unfollowed" : "followed",
        });

    } catch (err) {
        console.error('Error following/unfollowing group:', err);
        res.status(500).json({ message: 'Error updating follow status' });
    }
});


module.exports = router;