const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');
const Article = require('../models/Article');
const mongoose = require('mongoose');
const admin = require('../firebaseAdmin');
const sendExpoNotification = require('../utils/sendExpoNotification');
const NotificationService = require('../utils/notificationService');
const ensureMongoUser = require('../middleware/ensureMongoUser')
const redisClient = require('../utils/redis');
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

// GET dashboard summary - optimized single endpoint
router.get('/dashboard-summary/:id', async (req, res) => {
    const startTime = Date.now();
    const userId = req.params.id;
    const noCache = req.query.noCache === '1';
    const cacheKey = `user_dashboard_summary_${userId}`;

    try {
        console.log(`Dashboard summary requested for user: ${userId}`);

        // Check cache first (with timeout)
        let cachedResult = null;
        if (!noCache && redisClient.isConnected()) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    cachedResult = JSON.parse(cached);
                    console.log(`Cache hit for user: ${userId}`);
                    res.set('Server-Timing', `summary_cache;dur=${Date.now() - startTime}`);
                    return res.json(cachedResult);
                }
            } catch (cacheErr) {
                console.warn('Cache read error:', cacheErr.message);
            }
        }

        // Fetch from DB with aggregation and timeout
        console.log(`Cache miss, querying DB for user: ${userId}`);
        const dbStartTime = Date.now();

        // Use find instead of aggregation for better reliability
        console.log(`Querying user directly: ${userId}`);
        const user = await User.findOne({ supabase_id: userId })
            .select('email name avatar_url profile_image following_sources following_users liked_articles disliked_articles saved_articles saved_reels')
            .lean()
            .maxTimeMS(3000);

        if (!user) {
            console.log(`User not found in DB: ${userId}`);
            return res.status(404).json({ message: 'User not found' });
        }

        const result = [{
            email: user.email || null,
            name: user.name || null,
            avatar_url: user.avatar_url || null,
            profile_image: user.profile_image || null,
            following_sources_count: (user.following_sources || []).length,
            following_users_count: (user.following_users || []).length,
            liked_count: (user.liked_articles || []).length,
            disliked_count: (user.disliked_articles || []).length,
            saved_count: (user.saved_articles || []).length,
            saved_reels_count: (user.saved_reels || []).length
        }];

        if (!result || result.length === 0) {
            console.log(`Query returned no results for user: ${userId}`);
            return res.status(404).json({ message: 'User not found' });
        }

        const summary = result[0];
        console.log(`DB query completed for user: ${userId} in ${Date.now() - dbStartTime}ms`);

        // Cache the result (with timeout)
        if (redisClient.isConnected()) {
            try {
                await redisClient.set(cacheKey, JSON.stringify(summary), 120);
            } catch (cacheErr) {
                console.warn('Cache write error:', cacheErr.message);
            }
        }

        const dbDuration = Date.now() - dbStartTime;
        const totalDuration = Date.now() - startTime;
        res.set('Server-Timing', `summary_db;dur=${dbDuration}, summary_total;dur=${totalDuration}`);

        console.log(`Dashboard summary completed for user: ${userId} in ${totalDuration}ms`);
        res.json(summary);

    } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`Error in /dashboard-summary/${userId} (${duration}ms):`, {
            message: err.message,
            stack: err.stack,
            name: err.name
        });

        // Return a minimal response on error instead of 500
        res.status(200).json({
            email: null,
            name: null,
            avatar_url: null,
            profile_image: null,
            following_sources_count: 0,
            following_users_count: 0,
            liked_count: 0,
            disliked_count: 0,
            saved_count: 0,
            saved_reels_count: 0,
            _error: true,
            _errorMessage: err.message
        });
    }
});

// GET user by Supabase ID
router.get('/by-supabase/:id', async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.params.id })
            .select('supabase_id email name avatar_url profile_image gender dob following_sources following_users')
            .select('-liked_articles -disliked_articles -saved_articles -embedding -embedding_pca');
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

router.post('/push-token', auth, ensureMongoUser, async (req, res) => {
    const { token } = req.body;

    if (!token) return res.status(400).json({ message: 'Push token is required' });

    try {
        // Use the user from ensureMongoUser middleware
        const user = req.mongoUser;
        user.pushToken = token;
        await user.save();

        res.json({ success: true, message: 'Push token saved' });
    } catch (err) {
        console.error('Error saving push token:', err);
        res.status(500).json({ message: 'Failed to save push token' });
    }
});

// routes/user.js

router.post('/test-notify', auth, ensureMongoUser, async (req, res) => {
    try {
        const user = req.mongoUser;
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
router.patch('/notification-settings', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const { notificationSettings } = req.body;

        if (!notificationSettings || typeof notificationSettings !== 'object') {
            return res.status(400).json({ message: 'Invalid notification settings' });
        }

        // Validate notification settings keys
        const validKeys = [
            'newsNotifications',
            'userNotifications',
            'breakingNews',
            'weeklyDigest',
            'followedSources',
            'articleLikes',
            'newFollowers',
            'mentions'
        ];

        const invalidKeys = Object.keys(notificationSettings).filter(key => !validKeys.includes(key));
        if (invalidKeys.length > 0) {
            return res.status(400).json({
                message: `Invalid notification setting keys: ${invalidKeys.join(', ')}`
            });
        }

        // Update user's notification settings
        const user = await User.findOneAndUpdate(
            { supabase_id },
            { $set: { notificationSettings } },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            message: 'Notification settings updated successfully',
            notificationSettings: user.notificationSettings
        });
    } catch (err) {
        console.error('Error updating notification settings:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get notification settings
router.get('/notification-settings', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const user = await User.findOne({ supabase_id });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ notificationSettings: user.notificationSettings });
    } catch (err) {
        console.error('Error fetching notification settings:', err);
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

// Admin route to send breaking news notifications
router.post('/admin/send-breaking-news', auth, async (req, res) => {
    try {
        // Note: You might want to add admin role verification here
        const { title, body, articleId, targetUsers } = req.body;

        if (!title || !body || !articleId) {
            return res.status(400).json({ message: 'Title, body, and articleId are required' });
        }

        let userIds = [];
        if (targetUsers && Array.isArray(targetUsers)) {
            userIds = targetUsers;
        } else {
            // Send to all users if no target users specified
            const allUsers = await User.find({}, 'supabase_id');
            userIds = allUsers.map(user => user.supabase_id);
        }

        const result = await NotificationService.sendBulkNotification(
            userIds,
            'breakingNews',
            title,
            body,
            { articleId, type: 'breaking_news' }
        );

        res.json({
            message: 'Breaking news notifications sent',
            successful: result.successful,
            failed: result.failed
        });
    } catch (err) {
        console.error('Error sending breaking news notifications:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Admin route to send followed source notifications
router.post('/admin/send-followed-source-notification', auth, async (req, res) => {
    try {
        const { sourceName, title, articleId } = req.body;

        if (!sourceName || !title || !articleId) {
            return res.status(400).json({ message: 'Source name, title, and articleId are required' });
        }

        // Find users who follow this source
        const followingUsers = await User.find({
            following_sources: sourceName
        }, 'supabase_id');

        const userIds = followingUsers.map(user => user.supabase_id);

        const result = await NotificationService.sendBulkNotification(
            userIds,
            'followedSources',
            `New from ${sourceName}`,
            title,
            { articleId, sourceName, type: 'followed_source' }
        );

        res.json({
            message: 'Followed source notifications sent',
            successful: result.successful,
            failed: result.failed
        });
    } catch (err) {
        console.error('Error sending followed source notifications:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Admin route to send weekly digest
router.post('/admin/send-weekly-digest', auth, async (req, res) => {
    try {
        const { title, body, data, targetUsers } = req.body;

        if (!title || !body) {
            return res.status(400).json({ message: 'Title and body are required' });
        }

        let userIds = [];
        if (targetUsers && Array.isArray(targetUsers)) {
            userIds = targetUsers;
        } else {
            // Send to all users if no target users specified
            const allUsers = await User.find({}, 'supabase_id');
            userIds = allUsers.map(user => user.supabase_id);
        }

        const result = await NotificationService.sendBulkNotification(
            userIds,
            'weeklyDigest',
            title,
            body,
            { ...data, type: 'weekly_digest' }
        );

        res.json({
            message: 'Weekly digest notifications sent',
            successful: result.successful,
            failed: result.failed
        });
    } catch (err) {
        console.error('Error sending weekly digest notifications:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Search users endpoint
router.get('/search', auth, async (req, res) => {
    try {
        const query = req.query.query?.trim();

        if (!query) return res.status(400).json({ message: 'Missing search query' });

        const regex = new RegExp(query, 'i'); // case-insensitive
        const results = await User.find({
            $or: [
                { name: { $regex: regex } },
                { email: { $regex: regex } }
            ]
        })
            .select('supabase_id name email profile_image following_sources following_users') // Only return necessary fields
            .sort({ createdAt: -1 }) // Sort by creation date
            .limit(20); // Limit results

        res.json(results);
    } catch (error) {
        console.error('Error in users search:', error);
        res.status(500).json({ message: 'Error searching users', error: error.message });
    }
});

// Suggested MongoDB indexes for optimal performance:
// db.users.createIndex({ supabase_id: 1 })
// db.users.createIndex({ email: 1 })

module.exports = router;
