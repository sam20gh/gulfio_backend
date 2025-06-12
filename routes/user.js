const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Article = require('../models/Article');
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


// LIKE or DISLIKE a Reel
router.post('/:id/like-reel', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const reelId = req.params.id;
    const { action } = req.body; // 'like' or 'dislike'

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);
    const isLiked = user.liked_reels?.some(id => id.equals(reelObjectId));
    const isDisliked = user.disliked_reels?.some(id => id.equals(reelObjectId));

    if (action === 'like') {
        if (!isLiked) user.liked_reels.push(reelObjectId);
        if (isDisliked) user.disliked_reels.pull(reelObjectId);
    } else if (action === 'dislike') {
        if (!isDisliked) {
            user.disliked_reels = user.disliked_reels || [];
            user.disliked_reels.push(reelObjectId);
        }
        if (isLiked) user.liked_reels.pull(reelObjectId);
    } else {
        return res.status(400).json({ message: 'Invalid action type' });
    }

    await user.save();

    res.json({
        liked_reels: user.liked_reels,
        disliked_reels: user.disliked_reels || [],
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

    try {
        const isSaved = user.saved_reels?.some(id => id.equals(reelObjectId));

        if (isSaved) {
            user.saved_reels.pull(reelObjectId);
        } else {
            user.saved_reels.addToSet(reelObjectId);
        }

        await user.save();
        res.json({
            isSaved: !isSaved,
            saved_reels: user.saved_reels,
        });
    } catch (err) {
        console.error('Error saving/unsaving reel:', err);
        res.status(500).json({ message: 'Error saving/unsaving reel' });
    }
});

// VIEW a Reel (mark as viewed)
router.post('/:id/view-reel', auth, ensureMongoUser, async (req, res) => {
    const user = req.mongoUser;
    const reelId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reelId)) {
        return res.status(400).json({ message: 'Invalid reel ID' });
    }

    const reelObjectId = new mongoose.Types.ObjectId(reelId);

    if (!user.viewed_reels?.some(id => id.equals(reelObjectId))) {
        user.viewed_reels.addToSet(reelObjectId);
        await user.save();
    }

    res.json({ viewed_reels: user.viewed_reels });
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


module.exports = router;
