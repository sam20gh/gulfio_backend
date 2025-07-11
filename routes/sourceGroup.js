const express = require('express');
const router = express.Router();
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const Reel = require('../models/Reel');
const auth = require('../middleware/auth'); // Supabase auth
const ensureMongoUser = require('../middleware/ensureMongoUser');

// Get source group info + top articles + recent articles
router.get('/group/:groupName', async (req, res) => {
    const { groupName } = req.params;

    try {
        const sources = await Source.find({ groupName });
        if (!sources.length) return res.status(404).json({ message: 'No sources found for this group' });

        const mainSource = sources[0];
        const sourceIds = sources.map(source => source._id);

        const topArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ likeCount: -1 })
            .limit(5)
            .select('_id title publishedAt likeCount url image');

        const recentArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ publishedAt: -1 })
            .limit(10)
            .select('_id title publishedAt url image');

        const reels = await Reel.find({ source: { $in: sourceIds } })
            .sort({ publishedAt: -1 })
            .limit(10)
            .select('_id description videoUrl thumbnail publishedAt');

        const userFollowing = false; // unauthenticated users can't follow

        res.json({
            sourceInfo: {
                name: mainSource.name,
                icon: mainSource.icon,
                followers: sources.reduce((acc, s) => acc + (s.followers || 0), 0),
                _id: mainSource._id,
            },
            topArticles,
            recentArticles,
            reels,
            userFollowing,
        });

    } catch (error) {
        console.error('Error fetching source group:', error);
        res.status(500).json({ message: 'Error fetching source group' });
    }
});

// Follow/Unfollow Source Group
router.post('/follow-group', auth, ensureMongoUser, async (req, res) => {
    const { groupName } = req.body;
    const user = req.mongoUser;

    try {
        if (!groupName) return res.status(400).json({ message: 'groupName is required' });

        const isFollowing = user.following_sources.includes(groupName);

        if (isFollowing) {
            // Unfollow
            user.following_sources.pull(groupName);
            await Source.updateMany({ groupName }, { $inc: { followers: -1 } });
        } else {
            // Follow
            user.following_sources.push(groupName);
            await Source.updateMany({ groupName }, { $inc: { followers: 1 } });
        }

        await user.save();

        res.json({
            following_sources: user.following_sources,
            action: isFollowing ? 'unfollowed' : 'followed',
        });
    } catch (error) {
        console.error('Error following/unfollowing group:', error);
        res.status(500).json({ message: 'Error updating follow status' });
    }
});


module.exports = router;
