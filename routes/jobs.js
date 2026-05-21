/**
 * Background Jobs API Routes
 * 
 * PHASE 2: Optimization - Background job endpoints
 * - User embedding updates
 * - Cache warming
 * - Analytics aggregation
 * 
 * AUTHENTICATION:
 * - Requires x-api-key header with ADMIN_API_KEY
 * - Called by Cloud Scheduler or manual triggers
 */

const express = require('express');
const router = express.Router();

// Try to load background jobs with error handling
let updateActiveUserEmbeddings;
try {
    console.log('📂 Loading update-user-embeddings job...');
    const jobModule = require('../jobs/update-user-embeddings');
    updateActiveUserEmbeddings = jobModule.updateActiveUserEmbeddings;
    console.log('✅ update-user-embeddings loaded');
} catch (error) {
    console.error('❌ Failed to load update-user-embeddings:', error.message);
    updateActiveUserEmbeddings = null;
}

let updateSourceQualityScores;
try {
    console.log('📂 Loading update-source-quality job...');
    const jobModule = require('../jobs/update-source-quality');
    updateSourceQualityScores = jobModule.updateSourceQualityScores;
    console.log('✅ update-source-quality loaded');
} catch (error) {
    console.error('❌ Failed to load update-source-quality:', error.message);
    updateSourceQualityScores = null;
}

const { ADMIN_API_KEY } = process.env;

// Middleware: Verify admin API key
const verifyAdminKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== ADMIN_API_KEY) {
        console.warn('⚠️ Unauthorized job request:', req.ip);
        return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    next();
};

/**
 * POST /api/jobs/update-user-embeddings
 * Update embeddings for active users based on all their interactions
 * 
 * SCHEDULE: Daily at 2 AM UTC
 * IMPACT: Maintains 10x performance improvement for active users
 * 
 * CONTENT SUPPORT:
 * - ✅ Articles (views, likes, dislikes, saves)
 * - ✅ Reels/Videos (views, likes, dislikes, saves)
 * - ✅ Comments (strong engagement signal)
 * - Unified embedding generation from all user activities
 * 
 * Request headers:
 * - x-api-key: ADMIN_API_KEY
 * 
 * Response:
 * {
 *   success: true,
 *   processed: 150,
 *   updated: 142,
 *   skipped: 5,
 *   failed: 3,
 *   duration: 45230,
 *   usersPerSecond: "3.31"
 * }
 */
router.post('/update-user-embeddings', verifyAdminKey, async (req, res) => {
    try {
        if (!updateActiveUserEmbeddings) {
            return res.status(503).json({
                success: false,
                error: 'Background job not available - check server logs'
            });
        }

        console.log('🚀 Starting user embedding update job...');

        const result = await updateActiveUserEmbeddings();

        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('❌ Job execution error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/jobs/update-source-quality
 *
 * Recompute Source.quality_score from 30d of like/dislike data (P3-5).
 * Multiplied into the personalized scorer so low-quality sources
 * self-demote without manual intervention.
 *
 * SCHEDULE: Daily at 02:30 UTC (just after the embedding update job).
 */
router.post('/update-source-quality', verifyAdminKey, async (req, res) => {
    try {
        if (!updateSourceQualityScores) {
            return res.status(503).json({
                success: false,
                error: 'update-source-quality job not available - check server logs',
            });
        }
        const result = await updateSourceQualityScores();
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('❌ Job execution error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/jobs/status
 * Check job system status
 */
router.get('/status', verifyAdminKey, (req, res) => {
    res.json({
        status: 'ok',
        jobs: [
            {
                name: 'update-user-embeddings',
                endpoint: '/api/jobs/update-user-embeddings',
                schedule: '0 2 * * *',
                description: 'Update User.embedding_pca for active users daily (Articles + Reels + Comments)'
            },
            {
                name: 'update-source-quality',
                endpoint: '/api/jobs/update-source-quality',
                schedule: '30 2 * * *',
                description: 'Recompute Source.quality_score from 30d like/dislike data (P3-5)'
            }
        ],
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
