const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Article = require('../models/Article');
const admin = require('../firebaseAdmin');
const sendExpoNotification = require('../utils/sendExpoNotification');
const ensureMongoUser = require('../middleware/ensureMongoUser')

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
        res.json({
            count: likedIds.length,
            articles
        });
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
        res.json({
            count: dislikedIds.length,
            articles
        });
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
        res.json({
            count: savedIds.length,
            articles
        });
    } catch (err) {
        console.error('Error in /:id/saved-articles:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});
router.post('/push-token', auth, async (req, res) => {
    const supabase_id = req.user.sub;
    const { token } = req.body;

    if (!token) return res.status(400).json({ message: 'Push token is required' });

    try {
        let user = await User.findOne({ supabase_id });

        if (!user) {
            // Optional: auto-create user if not found
            const { email, name, picture } = req.user;
            user = await User.create({
                supabase_id,
                email: email || '',
                name: name || '',
                avatar_url: picture || '',
                pushToken: token,
            });
        } else {
            user.pushToken = token;
            await user.save();
        }

        res.json({ success: true, message: 'Push token saved' });
    } catch (err) {
        console.error('Error saving push token:', err);
        res.status(500).json({ message: 'Failed to save push token' });
    }
});

// routes/user.js

router.post('/test-notify', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const user = await User.findOne({ supabase_id });
        if (!user?.pushToken) {
            return res.status(404).json({ message: 'No push token for this user' });
        }

        // Send test via Expo
        await sendExpoNotification(
            '🧪 Test Notification',
            'If you see this, Expo push is working!',
            [user.pushToken]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Test notify error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});
router.get('/me', auth, ensureMongoUser, (req, res) => {
    const user = req.mongoUser
    res.json({
        email: user.email,
        name: user.name,
        avatar_url: user.avatar_url,
        profile_image: user.profile_image,
        gender: user.gender,
        dob: user.dob,
    })
})

router.put('/update', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const { name, gender, dob, avatar_url } = req.body;

    if (name !== undefined) user.name = name;
    if (gender !== undefined) user.gender = gender;
    if (dob !== undefined) user.dob = new Date(dob);
    if (avatar_url !== undefined) user.profile_image = avatar_url;

    await user.save();
    res.json({ message: 'Profile updated' });
});

const axios = require('axios');

router.post('/get-upload-url', auth, async (req, res) => {
    console.log('CF_ACCOUNT_ID:', process.env.CF_ACCOUNT_ID);
    console.log('CF_API_TOKEN exists:', !!process.env.CF_API_TOKEN);
    try {
        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v2/direct_upload`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
                },
            }

        );
        res.json(response.data);
    } catch (err) {
        console.error('Cloudflare upload error:', err.response?.data || err.message);
        res.status(500).json({ message: 'Failed to get upload URL', cloudflareError: err.response?.data || err.message });
    }
});




module.exports = router;
