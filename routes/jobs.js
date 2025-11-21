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

// Try to load background job with error handling
let updateActiveUserEmbeddings;
try {
    console.log('📂 Loading update-user-embeddings job...');
    const jobModule = require('../jobs/update-user-embeddings');
    updateActiveUserEmbeddings = jobModule.updateActiveUserEmbeddings;
    console.log('✅ Background job loaded successfully');
} catch (error) {
    console.error('❌ Failed to load background job:', error.message);
    updateActiveUserEmbeddings = null;
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
                description: 'Update User.embedding_pca for active users daily (Articles + Reels)'
            }
        ],
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
