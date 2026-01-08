const express = require('express');
const router = express.Router();
const Source = require('../models/Source');
const Reel = require('../models/Reel');
const Article = require('../models/Article');
const { invalidateSourceCache } = require('../utils/sourceCache');

const { scrapeReelsForSource } = require('../scraper/instagramReels');
const { scrapeYouTubeForSource } = require('../scraper/youtubeScraper');
// Avoid redeclaring 'auth' if already declared elsewhere
let auth;
try {
    auth = require('../middleware/auth');
} catch (err) {
    console.warn('Auth middleware not found. Skipping auth.');
    auth = (_, __, next) => next();
}

router.get('/', auth, async (req, res) => {
    try {
        const sources = await Source.find({ status: { $ne: 'blocked' } });

        // Get article counts for each source
        const sourceIds = sources.map(s => s._id);
        const articleCounts = await Article.aggregate([
            { $match: { sourceId: { $in: sourceIds } } },
            { $group: { _id: '$sourceId', count: { $sum: 1 } } }
        ]);

        // Create a map for quick lookup
        const countMap = {};
        articleCounts.forEach(item => {
            countMap[item._id.toString()] = item.count;
        });

        // Add article count to each source
        const sourcesWithCounts = sources.map(source => {
            const sourceObj = source.toObject();
            sourceObj.articleCount = countMap[source._id.toString()] || 0;
            return sourceObj;
        });

        res.json(sourcesWithCounts);
    } catch (err) {
        console.error('Error fetching sources with article counts:', err);
        res.status(500).json({ message: err.message });
    }
});

router.post('/', auth, async (req, res) => {
    try {
        const newSource = new Source(req.body);
        await newSource.save();
        await invalidateSourceCache(); // Clear cache when source added
        res.status(201).json(newSource);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});
router.put('/:id', auth, async (req, res) => {
    try {
        const updated = await Source.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updated) return res.status(404).json({ message: 'Source not found' });
        await invalidateSourceCache(); // Clear cache when source updated
        res.json(updated);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});
router.delete('/:id', auth, async (req, res) => {
    try {
        const deleted = await Source.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Source not found' });
        await invalidateSourceCache(); // Clear cache when source deleted
        res.json({ message: 'Source deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.get('/:id/instagram/reels', async (req, res) => {
    try {
        const source = await Source.findById(req.params.id);
        if (!source || !source.instagramUsername) {
            return res.status(404).json({ error: 'No Instagram account configured' });
        }
        const reels = await scrapeReelsForSource(
            source._id,
            source.instagramUsername
        );
        res.json(reels);
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: err.message });
    }
});
router.post('/:id/youtube', async (req, res) => {
    const { youtubeChannelId } = req.body;
    if (!youtubeChannelId) {
        return res.status(400).json({ error: 'YouTube Channel ID is required' });
    }
    try {
        const source = await Source.findByIdAndUpdate(
            req.params.id,
            { youtubeChannelId },
            { new: true }
        );
        if (!source) return res.status(404).json({ error: 'Source not found' });
        res.json(source);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sources/:id/youtube/videos
router.get('/:id/youtube/videos', async (req, res) => {
    try {
        const source = await Source.findById(req.params.id);
        if (!source || !source.youtubeChannelId) {
            return res.status(404).json({ error: 'YouTube Channel not configured' });
        }
        const videos = await scrapeYouTubeForSource(source._id, source.youtubeChannelId);
        res.json(videos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Search sources endpoint
router.get('/search', auth, async (req, res) => {
    try {
        const query = req.query.query?.trim();
        const language = req.query.language || 'english';

        if (!query) return res.status(400).json({ message: 'Missing search query' });

        const regex = new RegExp(query, 'i'); // case-insensitive
        const results = await Source.find({
            $and: [
                {
                    $or: [
                        { name: { $regex: regex } },
                        { category: { $regex: regex } },
                        { groupName: { $regex: regex } }
                    ]
                },
                { language }, // Add language filter
                { status: { $ne: 'blocked' } } // Exclude blocked sources
            ]
        })
            .sort({ followers: -1 }) // Sort by popularity
            .limit(20); // Limit results

        res.json(results);
    } catch (error) {
        console.error('Error in sources search:', error);
        res.status(500).json({ message: 'Error searching sources', error: error.message });
    }
});

module.exports = router;
