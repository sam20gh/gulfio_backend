const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // Keep auth for other routes
const User = require('../models/User');
const Article = require('../models/Article'); // Import Article model
const mongoose = require('mongoose');
const ensureMongoUser = require('../middleware/ensureMongoUser'); // Keep ensureMongoUser for other routes

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

    res.json({
        liked_articles: user.liked_articles,
        disliked_articles: user.disliked_articles || [],
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

    if (!validateObjectId(articleId))
        return res.status(400).json({ message: 'Invalid article ID' });

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    try {
        const isSaved = user.saved_articles.some(id => id.equals(articleObjectId));

        if (isSaved) {
            user.saved_articles.pull(articleObjectId);
        } else {
            user.saved_articles.push(articleObjectId); // or use addToSet to prevent dupes
        }

        await user.save();

        res.json({ saved_articles: user.saved_articles });
    } catch (err) {
        console.error('Error saving article:', err);
        res.status(500).json({ message: 'Error saving article' });
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
        res.json({ following_sources: user.following_sources });
    } catch (err) {
        console.error('Error following source:', err); // Log the error
        res.status(500).json({ message: 'Error following source' });
    }
});

// Follow/Block Another User (Requires auth and ensureMongoUser)
router.post('/user/:targetSupabaseId/action', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser; // Use ensureMongoUser result
    const { targetSupabaseId } = req.params; // Assuming targetId is supabase_id
    const { action } = req.body; // 'follow' or 'block'

    // Find the target user by supabase_id to ensure they exist
    const targetUser = await User.findOne({ supabase_id: targetSupabaseId });
    if (!targetUser) {
        return res.status(404).json({ message: 'Target user not found' });
    }
    const targetMongoId = targetUser._id; // Use the MongoDB _id for relationships

    if (!targetMongoId || targetMongoId.equals(user._id)) {
        return res.status(400).json({ message: 'Invalid user target or cannot target self' });
    }

    try {
        // Convert targetMongoId to string if storing supabase_id, or keep as ObjectId if storing _id
        // Assuming following_users and blocked_users store MongoDB _ids
        const isFollowing = user.following_users.some(id => id.equals(targetMongoId));
        const isBlocked = user.blocked_users.some(id => id.equals(targetMongoId));

        if (action === 'follow') {
            if (!isFollowing) user.following_users.push(targetMongoId);
            if (isBlocked) user.blocked_users.pull(targetMongoId); // unblocks if followed
        } else if (action === 'unfollow') {
            if (isFollowing) user.following_users.pull(targetMongoId);
        } else if (action === 'block') {
            if (!isBlocked) user.blocked_users.push(targetMongoId);
            if (isFollowing) user.following_users.pull(targetMongoId); // unfollows if blocked
        } else if (action === 'unblock') {
            if (isBlocked) user.blocked_users.pull(targetMongoId);
        } else {
            return res.status(400).json({ message: 'Invalid action' });
        }

        await user.save();
        res.json({
            following_users: user.following_users,
            blocked_users: user.blocked_users
        });
    } catch (err) {
        console.error('Error updating relationship:', err); // Log the error
        res.status(500).json({ message: 'Error updating relationship' });
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
