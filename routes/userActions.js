const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const User = require('../models/User');
const mongoose = require('mongoose');
const ensureMongoUser = require('../middleware/ensureMongoUser')

function validateObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// Like/Dislike Article

router.post('/article/:id/like', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const articleId = req.params.id;
    const { action } = req.body;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);
    const alreadyLiked = user.liked_articles.some(id => id.equals(articleObjectId));

    if (action === 'like' && !alreadyLiked) {
        user.liked_articles.push(articleObjectId);
    } else if (action === 'dislike' && alreadyLiked) {
        user.liked_articles.pull(articleObjectId);
    }

    await user.save();
    res.json({ liked_articles: user.liked_articles });
});

// Mark Article as Viewed
router.post('/article/:articleId/view', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const { articleId } = req.params;

    if (!validateObjectId(articleId)) {
        return res.status(400).json({ message: 'Invalid article ID' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    // Check if the article is already marked as viewed
    const alreadyViewed = user.viewed_articles.some(id => id.equals(articleObjectId));

    if (!alreadyViewed) {
        user.viewed_articles.push(articleObjectId);
        try {
            await user.save();
            res.json({ message: 'Article marked as viewed', viewed_articles: user.viewed_articles });
        } catch (err) {
            console.error('Error marking article as viewed:', err);
            res.status(500).json({ message: 'Error updating viewed articles' });
        }
    } else {
        // Optionally, you could just return success even if already viewed
        res.json({ message: 'Article already marked as viewed', viewed_articles: user.viewed_articles });
    }
});

// Save/Unsave Article
router.post('/article/:id/save', auth, async (req, res) => {
    const userId = req.user.sub;
    const articleId = req.params.id;

    if (!validateObjectId(articleId)) return res.status(400).json({ message: 'Invalid article ID' });

    try {
        const user = await User.findOne({ supabase_id: userId });

        if (user.saved_articles.includes(articleId)) {
            user.saved_articles.pull(articleId);
        } else {
            user.saved_articles.push(articleId);
        }

        await user.save();
        res.json({ saved_articles: user.saved_articles });
    } catch (err) {
        res.status(500).json({ message: 'Error saving article' });
    }
});

// Follow/Unfollow Source
router.post('/source/:id/follow', auth, async (req, res) => {
    const userId = req.user.sub;
    const sourceId = req.params.id;

    if (!validateObjectId(sourceId)) return res.status(400).json({ message: 'Invalid source ID' });

    try {
        const user = await User.findOne({ supabase_id: userId });

        if (user.following_sources.includes(sourceId)) {
            user.following_sources.pull(sourceId);
        } else {
            user.following_sources.push(sourceId);
        }

        await user.save();
        res.json({ following_sources: user.following_sources });
    } catch (err) {
        res.status(500).json({ message: 'Error following source' });
    }
});

// Follow/Block Another User
router.post('/user/:targetId/action', auth, async (req, res) => {
    const userId = req.user.sub;
    const { targetId } = req.params;
    const { action } = req.body; // 'follow' or 'block'

    if (!targetId || targetId === userId) return res.status(400).json({ message: 'Invalid user target' });

    try {
        const user = await User.findOne({ supabase_id: userId });

        if (action === 'follow') {
            if (!user.following_users.includes(targetId)) user.following_users.push(targetId);
            user.blocked_users = user.blocked_users.filter(id => id !== targetId); // unblocks if followed
        } else if (action === 'block') {
            if (!user.blocked_users.includes(targetId)) user.blocked_users.push(targetId);
            user.following_users = user.following_users.filter(id => id !== targetId); // unfollows if blocked
        } else {
            return res.status(400).json({ message: 'Invalid action' });
        }

        await user.save();
        res.json({
            following_users: user.following_users,
            blocked_users: user.blocked_users
        });
    } catch (err) {
        res.status(500).json({ message: 'Error updating relationship' });
    }
});

module.exports = router;
