const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Article = require('../models/Article');

router.post('/check-or-create', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const { email, name, picture } = req.user;

        let user = await User.findOne({ supabase_id });
        if (!user) {
            user = await User.create({
                supabase_id,
                email,
                name,
                avatar_url: picture
            });
        }

        res.json(user);
    } catch (err) {
        console.error('User creation error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET user by Supabase ID
router.get('/by-supabase/:id', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error('Error in /by-supabase/:id:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ✅ Get liked articles
router.get('/:id/liked-articles', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const likedIds = user.liked_articles || [];
        if (likedIds.length === 0) return res.json([]);

        const articles = await Article.find({ _id: { $in: likedIds } }).sort({ publishedAt: -1 });
        res.json(articles);
    } catch (err) {
        console.error('Error in /:id/liked-articles:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ✅ Get disliked articles
router.get('/:id/disliked-articles', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const dislikedIds = user.disliked_articles || [];
        if (dislikedIds.length === 0) return res.json([]);

        const articles = await Article.find({ _id: { $in: dislikedIds } }).sort({ publishedAt: -1 });
        res.json(articles);
    } catch (err) {
        console.error('Error in /:id/disliked-articles:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ✅ Get saved articles
router.get('/:id/saved-articles', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const savedIds = user.saved_articles || [];
        if (savedIds.length === 0) return res.json([]);

        const articles = await Article.find({ _id: { $in: savedIds } }).sort({ publishedAt: -1 });
        res.json(articles);
    } catch (err) {
        console.error('Error in /:id/saved-articles:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});
router.post('/push-token', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const { token } = req.body;

    if (!token) return res.status(400).json({ message: 'Push token is required' });

    try {
        user.pushToken = token;
        await user.save();
        res.json({ success: true, message: 'Push token saved' });
    } catch (err) {
        console.error('Error saving push token:', err);
        res.status(500).json({ message: 'Failed to save push token' });
    }
});

module.exports = router;
