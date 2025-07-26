const express = require('express');
const router = express.Router();
const { thumbnailGenerator } = require('../services/ThumbnailGenerator');
const Reel = require('../models/Reel');

// Admin middleware (you may need to adjust this based on your auth system)
const requireAdmin = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Health check endpoint
router.get('/health', async (req, res) => {
    try {
        const health = await thumbnailGenerator.healthCheck();
        res.json(health);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Generate thumbnail for a specific video
router.post('/generate/:reelId', requireAdmin, async (req, res) => {
    try {
        const { reelId } = req.params;

        // Find the video
        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (reel.thumbnailUrl) {
            return res.status(400).json({
                error: 'Thumbnail already exists',
                thumbnailUrl: reel.thumbnailUrl
            });
        }

        console.log(`🔄 Generating thumbnail for reel: ${reelId}`);
        const thumbnailUrl = await thumbnailGenerator.generateThumbnail(reel.videoUrl, reelId);

        // Update the reel with thumbnail URL
        await Reel.findByIdAndUpdate(reelId, { thumbnailUrl });

        res.json({
            success: true,
            reelId,
            thumbnailUrl,
            message: 'Thumbnail generated successfully'
        });

    } catch (error) {
        console.error(`❌ Error generating thumbnail for ${req.params.reelId}:`, error);
        res.status(500).json({
            error: 'Failed to generate thumbnail',
            details: error.message
        });
    }
});

// Batch process videos without thumbnails
router.post('/batch-generate', requireAdmin, async (req, res) => {
    try {
        const { batchSize = 10 } = req.body;

        console.log(`🚀 Starting batch thumbnail generation (batch size: ${batchSize})`);
        const results = await thumbnailGenerator.processExistingVideos(batchSize);

        res.json({
            success: true,
            results,
            message: `Batch processing completed. ${results.successful} successful, ${results.failed} failed.`
        });

    } catch (error) {
        console.error('❌ Error in batch thumbnail generation:', error);
        res.status(500).json({
            error: 'Batch generation failed',
            details: error.message
        });
    }
});

// Get statistics about thumbnails
router.get('/stats', requireAdmin, async (req, res) => {
    try {
        const [totalVideos, videosWithThumbnails, videosWithoutThumbnails] = await Promise.all([
            Reel.countDocuments(),
            Reel.countDocuments({ thumbnailUrl: { $exists: true, $ne: null, $ne: '' } }),
            Reel.countDocuments({
                $or: [
                    { thumbnailUrl: { $exists: false } },
                    { thumbnailUrl: null },
                    { thumbnailUrl: '' }
                ]
            })
        ]);

        const coveragePercentage = totalVideos > 0 ?
            ((videosWithThumbnails / totalVideos) * 100).toFixed(2) : 0;

        res.json({
            totalVideos,
            videosWithThumbnails,
            videosWithoutThumbnails,
            coveragePercentage: `${coveragePercentage}%`,
            isComplete: videosWithoutThumbnails === 0
        });

    } catch (error) {
        console.error('❌ Error getting thumbnail stats:', error);
        res.status(500).json({
            error: 'Failed to get stats',
            details: error.message
        });
    }
});

// Get list of videos without thumbnails (for debugging)
router.get('/missing', requireAdmin, async (req, res) => {
    try {
        const { limit = 20, skip = 0 } = req.query;

        const videosWithoutThumbnails = await Reel.find({
            $or: [
                { thumbnailUrl: { $exists: false } },
                { thumbnailUrl: null },
                { thumbnailUrl: '' }
            ]
        })
            .select('_id videoUrl caption scrapedAt')
            .sort({ scrapedAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip));

        res.json({
            videos: videosWithoutThumbnails,
            count: videosWithoutThumbnails.length
        });

    } catch (error) {
        console.error('❌ Error getting videos without thumbnails:', error);
        res.status(500).json({
            error: 'Failed to get missing thumbnails',
            details: error.message
        });
    }
});

// Regenerate thumbnail (force regeneration even if exists)
router.post('/regenerate/:reelId', requireAdmin, async (req, res) => {
    try {
        const { reelId } = req.params;

        // Find the video
        const reel = await Reel.findById(reelId);
        if (!reel) {
            return res.status(404).json({ error: 'Video not found' });
        }

        console.log(`🔄 Regenerating thumbnail for reel: ${reelId}`);
        const thumbnailUrl = await thumbnailGenerator.generateThumbnail(reel.videoUrl, reelId);

        // Update the reel with new thumbnail URL
        await Reel.findByIdAndUpdate(reelId, { thumbnailUrl });

        res.json({
            success: true,
            reelId,
            thumbnailUrl,
            message: 'Thumbnail regenerated successfully'
        });

    } catch (error) {
        console.error(`❌ Error regenerating thumbnail for ${req.params.reelId}:`, error);
        res.status(500).json({
            error: 'Failed to regenerate thumbnail',
            details: error.message
        });
    }
});

module.exports = router;
