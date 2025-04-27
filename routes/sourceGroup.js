const express = require('express');
const router = express.Router();
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth'); // Supabase auth
const ensureMongoUser = require('../middleware/ensureMongoUser');

// Get source group info + top articles + recent articles
router.get('/group/:groupName', auth, ensureMongoUser, async (req, res) => {
    const { groupName } = req.params;
    const user = req.mongoUser;

    try {
        // Find all sources under this group
        const sources = await Source.find({ groupName });

        if (!sources.length) {
            return res.status(404).json({ message: 'No sources found for this group' });
        }

        // Pick the first source as the "main" representative
        const mainSource = sources[0];

        const sourceIds = sources.map(source => source._id);

        // Find Top Articles (by likeCount, limit 5)
        const topArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ likeCount: -1 })
            .limit(5)
            .select('_id title publishedAt likeCount');

        // Find Recent Articles (by publish date, limit 10)
        const recentArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ publishedAt: -1 })
            .limit(10)
            .select('_id title publishedAt');

        // Check if user is following this group
        const userFollowing = user.following_sources.includes(groupName);

        res.json({
            sourceInfo: {
                name: mainSource.name,
                icon: mainSource.icon,
                followers: sources.reduce((acc, s) => acc + (s.followers || 0), 0), // Sum followers
            },
            topArticles,
            recentArticles,
            userFollowing
        });

    } catch (error) {
        console.error('Error fetching source group:', error);
        res.status(500).json({ message: 'Error fetching source group' });
    }
});

module.exports = router;
