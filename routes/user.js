const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Article = require('../models/Article');
const mongoose = require('mongoose');
const admin = require('../firebaseAdmin');
const sendExpoNotification = require('../utils/sendExpoNotification');
const ensureMongoUser = require('../middleware/ensureMongoUser')
const axios = require('axios');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');
const Reel = require('../models/Reel');
const FormData = require('form-data')
const form = new FormData()


router.post('/check-or-create', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const { name, picture } = req.user;
        const rawEmail = req.user.email || `${req.user.sub}@phone.user`;

        let user = await User.findOne({ supabase_id });
        if (!user) {
            user = await User.create({
                supabase_id,
                email: rawEmail,
                name,
                avatar_url: picture
            });
            await updateUserProfileEmbedding(user._id);
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
// ✅ Get liked articles
router.get('/:id/liked-articles', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const likedIds = user.liked_articles || [];
        if (likedIds.length === 0) return res.json([]);

        const articles = await Article.find({ _id: { $in: likedIds } }).sort({ publishedAt: -1 }).select('-embedding');;
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

        const articles = await Article.find({ _id: { $in: dislikedIds } }).sort({ publishedAt: -1 }).select('-embedding');;
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

        const articles = await Article.find({ _id: { $in: savedIds } }).sort({ publishedAt: -1 }).select('-embedding');;
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
    const { name, gender, dob, avatar_url, profile_image } = req.body;

    if (profile_image !== undefined) user.profile_image = profile_image;
    else if (avatar_url !== undefined) user.profile_image = avatar_url;

    if (name !== undefined) user.name = name;
    if (gender !== undefined) user.gender = gender;
    if (dob !== undefined) user.dob = new Date(dob);

    await user.save();
    res.json({ message: 'Profile updated' });
});




router.post('/get-upload-url', auth, async (req, res) => {
    try {
        const form = new FormData();
        form.append('metadata', JSON.stringify({})); // 👈 fixes multipart stream

        const response = await axios.post(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v2/direct_upload`,
            form,
            {
                headers: {
                    Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
                    ...form.getHeaders(),
                },
            }
        );

        res.json(response.data);
    } catch (err) {
        console.error('Cloudflare upload error:', err.response?.data || err.message);
        res.status(500).json({
            message: 'Failed to get upload URL',
            cloudflareError: err.response?.data || err.message,
        });
    }
});

// Update notification settings
router.put('/notification-settings', auth, ensureMongoUser, async (req, res) => {
    try {
        const user = req.mongoUser;
        const { notificationSettings } = req.body;

        // Validate notification settings structure
        if (!notificationSettings || typeof notificationSettings !== 'object') {
            return res.status(400).json({ message: 'Invalid notification settings' });
        }

        // Update user's notification settings
        user.notificationSettings = {
            ...user.notificationSettings,
            ...notificationSettings
        };

        await user.save();
        res.json({ message: 'Notification settings updated successfully', notificationSettings: user.notificationSettings });
    } catch (err) {
        console.error('Error updating notification settings:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// LIKE or DISLIKE a Reel
router.post('/:id/like-reel', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const reelId = req.params.id;
    const { action } = req.body; // 'like' or 'dislike'

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);
    const reel = await Reel.findById(reelObjectId);
    if (!reel) return res.status(404).json({ message: 'Reel not found' });

    const userId = user.supabase_id;

    const isLiked = user.liked_reels?.some(id => id.equals(reelObjectId));
    const isDisliked = user.disliked_reels?.some(id => id.equals(reelObjectId));
    const wasLikedBy = reel.likedBy.includes(userId);
    const wasDislikedBy = reel.dislikedBy.includes(userId);

    if (action === 'like') {
        // --- User ---
        if (!isLiked) user.liked_reels.push(reelObjectId);
        if (isDisliked) user.disliked_reels.pull(reelObjectId);

        // --- Reel ---
        if (!wasLikedBy) {
            reel.likes += 1;
            reel.likedBy.push(userId);
        }
        if (wasDislikedBy) {
            reel.dislikes = Math.max(reel.dislikes - 1, 0);
            reel.dislikedBy = reel.dislikedBy.filter(id => id !== userId);
        }
    } else if (action === 'dislike') {
        // --- User ---
        if (!isDisliked) user.disliked_reels.push(reelObjectId);
        if (isLiked) user.liked_reels.pull(reelObjectId);

        // --- Reel ---
        if (!wasDislikedBy) {
            reel.dislikes += 1;
            reel.dislikedBy.push(userId);
        }
        if (wasLikedBy) {
            reel.likes = Math.max(reel.likes - 1, 0);
            reel.likedBy = reel.likedBy.filter(id => id !== userId);
        }
    } else {
        return res.status(400).json({ message: 'Invalid action type' });
    }

    await user.save();
    await reel.save();

    res.json({
        liked_reels: user.liked_reels,
        disliked_reels: user.disliked_reels,
        likes: reel.likes,
        dislikes: reel.dislikes,
        likedBy: reel.likedBy,
        dislikedBy: reel.dislikedBy,
    });
});

// SAVE or UNSAVE a Reel
router.post('/:id/save-reel', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const reelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);
    const reel = await Reel.findById(reelObjectId);
    if (!reel) return res.status(404).json({ message: 'Reel not found' });

    const userId = user.supabase_id;
    const isSaved = user.saved_reels?.some(id => id.equals(reelObjectId));
    const wasSavedBy = reel.savedBy.includes(userId);

    if (isSaved) {
        // --- User ---
        user.saved_reels.pull(reelObjectId);
        // --- Reel ---
        if (wasSavedBy) {
            reel.saves = Math.max((reel.saves || 0) - 1, 0);
            reel.savedBy = reel.savedBy.filter(id => id !== userId);
        }
    } else {
        // --- User ---
        user.saved_reels.addToSet(reelObjectId);
        // --- Reel ---
        if (!wasSavedBy) {
            reel.saves = (reel.saves || 0) + 1;
            reel.savedBy.push(userId);
        }
    }

    await user.save();
    await reel.save();

    res.json({
        isSaved: !isSaved,
        saved_reels: user.saved_reels,
        saves: reel.saves,
        savedBy: reel.savedBy,
    });
});

// VIEW a Reel (mark as viewed)
router.post('/:id/view-reel', async (req, res) => {
    const reelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);
    const reel = await Reel.findById(reelObjectId);
    if (!reel) return res.status(404).json({ message: 'Reel not found' });

    // Try to get the logged-in user (if available)
    let userId = null;
    let user = null;
    try {
        // Optional: Use your auth middleware here, or manually decode token if needed
        if (req.headers.authorization) {
            // e.g. with JWT, decode and find user (pseudo-code):
            // const token = req.headers.authorization.replace('Bearer ', '');
            // const decoded = jwt.verify(token, YOUR_SECRET);
            // user = await User.findOne({ supabase_id: decoded.sub });
            // if (user) userId = user.supabase_id;
            // For now, rely on req.mongoUser if your middleware is active
            user = req.mongoUser;
            userId = user?.supabase_id;
        }
    } catch (e) {
        // Ignore error; treat as not logged in
    }

    let shouldSave = false;

    if (user && userId) {
        // If user has never viewed, mark in user and reel and increment
        const alreadyViewed = user.viewed_reels?.some(id => id.equals(reelObjectId));
        const wasViewedBy = reel.viewedBy.includes(userId);
        if (!alreadyViewed || !wasViewedBy) {
            reel.viewCount = (reel.viewCount || 0) + 1;
            shouldSave = true;
        }
        if (!alreadyViewed) user.viewed_reels.addToSet(reelObjectId);
        if (!wasViewedBy) reel.viewedBy.push(userId);
        await user.save();
    } else {
        // Not logged in: always increment viewCount
        reel.viewCount = (reel.viewCount || 0) + 1;
        shouldSave = true;
    }

    if (shouldSave) await reel.save();

    res.json({
        viewed: true,
        viewCount: reel.viewCount,
        viewedBy: reel.viewedBy,
    });
});

// GET liked reels
router.get('/:id/liked-reels', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const likedIds = user.liked_reels || [];
        if (likedIds.length === 0) return res.json([]);

        const reels = await Reel.find({ _id: { $in: likedIds } }).sort({ createdAt: -1 });
        res.json({ count: likedIds.length, reels });
    } catch (err) {
        console.error('Error in /:id/liked-reels:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET disliked reels
router.get('/:id/disliked-reels', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const dislikedIds = user.disliked_reels || [];
        if (dislikedIds.length === 0) return res.json([]);

        const reels = await Reel.find({ _id: { $in: dislikedIds } }).sort({ createdAt: -1 });
        res.json({ count: dislikedIds.length, reels });
    } catch (err) {
        console.error('Error in /:id/disliked-reels:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET saved reels
router.get('/:id/saved-reels', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const savedIds = user.saved_reels || [];
        if (savedIds.length === 0) return res.json([]);

        const reels = await Reel.find({ _id: { $in: savedIds } }).sort({ createdAt: -1 });
        res.json({ count: savedIds.length, reels });
    } catch (err) {
        console.error('Error in /:id/saved-reels:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET viewed reels
router.get('/:id/viewed-reels', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const viewedIds = user.viewed_reels || [];
        if (viewedIds.length === 0) return res.json([]);

        const reels = await Reel.find({ _id: { $in: viewedIds } }).sort({ createdAt: -1 });
        res.json({ count: viewedIds.length, reels });
    } catch (err) {
        console.error('Error in /:id/viewed-reels:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/reels/:id', async (req, res) => {
    try {
        const reel = await Reel.findById(req.params.id);
        if (!reel) return res.status(404).json({ message: 'Reel not found' });
        res.json(reel);
    } catch (err) {
        console.error('Error in /reels/:id:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/update-embedding', auth, async (req, res) => {
    const { embedding } = req.body;
    if (!embedding || !Array.isArray(embedding)) {
        return res.status(400).json({ message: 'embedding (array) required' });
    }
    const supabase_id = req.user.sub;
    try {
        const user = await User.findOne({ supabase_id });
        if (!user) return res.status(404).json({ message: 'User not found' });
        user.embedding = embedding;
        await user.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to update embedding' });
    }
});

// PUT notification settings
router.put('/notification-settings', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const { notificationSettings } = req.body;

        const user = await User.findOne({ supabase_id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.notificationSettings = {
            ...user.notificationSettings,
            ...notificationSettings
        };

        await user.save();
        res.json({ success: true, notificationSettings: user.notificationSettings });
    } catch (err) {
        console.error('Error updating notification settings:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET notification settings
router.get('/notification-settings', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const user = await User.findOne({ supabase_id });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ notificationSettings: user.notificationSettings || {} });
    } catch (err) {
        console.error('Error getting notification settings:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});


module.exports = router;
