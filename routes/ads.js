const express = require('express');
const router = express.Router();
const AdRevenueEvent = require('../models/AdRevenueEvent');
const Source = require('../models/Source');
const Article = require('../models/Article');
const mongoose = require('mongoose');

// Allowlist of valid ad unit IDs (only for source-attributed content)
const VALID_AD_UNIT_IDS = [
    'TEST', // For development/testing
    'ca-app-pub-6546605536002166/9412569479', // Article detail banner (source-specific content)
    // Note: List, football, and match detail ads don't participate in revenue sharing
    // as they are not source-specific content
];

// Rate limiting map (simple in-memory approach)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window

// Simple rate limiting middleware
const rateLimit = (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    
    // Clean old entries
    for (const [ip, requests] of rateLimits.entries()) {
        rateLimits.set(ip, requests.filter(time => time > windowStart));
        if (rateLimits.get(ip).length === 0) {
            rateLimits.delete(ip);
        }
    }
    
    // Check current IP
    const requests = rateLimits.get(clientIP) || [];
    if (requests.length >= RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Add current request
    requests.push(now);
    rateLimits.set(clientIP, requests);
    
    next();
};

// POST /api/ads/paid - Ingest ad revenue events
router.post('/paid', rateLimit, async (req, res) => {
    try {
        const { adUnitId, articleId, sourceId, value, currency, precision, platform } = req.body;
        
        // Validate required fields
        if (!adUnitId || !articleId || !sourceId || value === undefined || !currency || precision === undefined || !platform) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['adUnitId', 'articleId', 'sourceId', 'value', 'currency', 'precision', 'platform']
            });
        }
        
        // Validate adUnitId is in allowlist
        if (!VALID_AD_UNIT_IDS.includes(adUnitId)) {
            return res.status(400).json({ error: 'Invalid ad unit ID' });
        }
        
        // Validate ObjectId formats
        if (!mongoose.Types.ObjectId.isValid(articleId) || !mongoose.Types.ObjectId.isValid(sourceId)) {
            return res.status(400).json({ error: 'Invalid articleId or sourceId format' });
        }
        
        // Validate platform
        if (!['android', 'ios'].includes(platform)) {
            return res.status(400).json({ error: 'Platform must be android or ios' });
        }
        
        // Get source name
        const source = await Source.findById(sourceId).select('name');
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }
        
        // Verify article exists
        const article = await Article.findById(articleId).select('_id');
        if (!article) {
            return res.status(404).json({ error: 'Article not found' });
        }
        
        // Create ad revenue event
        const adRevenueEvent = new AdRevenueEvent({
            adUnitId,
            articleId,
            sourceId,
            sourceName: source.name,
            value,
            currency,
            precision,
            platform
        });
        
        await adRevenueEvent.save();
        
        console.log(`💰 Ad revenue event recorded: ${source.name}, $${(value / 1000000).toFixed(6)} ${currency}`);
        
        res.status(201).json({
            success: true,
            message: 'Ad revenue event recorded',
            eventId: adRevenueEvent._id
        });
        
    } catch (error) {
        console.error('❌ Error recording ad revenue event:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/summary/sources - Summarize revenue by source
router.get('/summary/sources', async (req, res) => {
    try {
        const { from, to, currency = 'USD' } = req.query;
        
        // Parse date range
        let dateFilter = {};
        if (from || to) {
            dateFilter.ts = {};
            if (from) {
                dateFilter.ts.$gte = new Date(from);
            }
            if (to) {
                dateFilter.ts.$lte = new Date(to);
            }
        }
        
        // Aggregate revenue by source
        const pipeline = [
            { $match: { currency, ...dateFilter } },
            {
                $group: {
                    _id: '$sourceId',
                    sourceName: { $first: '$sourceName' },
                    totalRevenue: { $sum: '$value' },
                    impressions: { $sum: 1 },
                    platforms: { $addToSet: '$platform' },
                    firstImpression: { $min: '$ts' },
                    lastImpression: { $max: '$ts' }
                }
            },
            {
                $lookup: {
                    from: 'sources',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'sourceInfo'
                }
            },
            {
                $addFields: {
                    sourceInfo: { $arrayElemAt: ['$sourceInfo', 0] },
                    totalRevenueUSD: { $divide: ['$totalRevenue', 1000000] }, // Convert from micro-units
                    averageRevenuePerImpression: { $divide: ['$totalRevenue', '$impressions'] }
                }
            },
            {
                $addFields: {
                    revSharePercent: { $ifNull: ['$sourceInfo.revSharePercent', 70] },
                    payoutCurrency: { $ifNull: ['$sourceInfo.payoutCurrency', 'USD'] }
                }
            },
            {
                $addFields: {
                    payout: {
                        $multiply: [
                            '$totalRevenueUSD',
                            { $divide: ['$revSharePercent', 100] }
                        ]
                    }
                }
            },
            {
                $project: {
                    sourceId: '$_id',
                    sourceName: 1,
                    totalRevenueUSD: { $round: ['$totalRevenueUSD', 6] },
                    impressions: 1,
                    platforms: 1,
                    firstImpression: 1,
                    lastImpression: 1,
                    averageRevenuePerImpression: { $round: [{ $divide: ['$averageRevenuePerImpression', 1000000] }, 8] },
                    revSharePercent: 1,
                    payoutCurrency: 1,
                    payout: { $round: ['$payout', 6] }
                }
            },
            { $sort: { totalRevenueUSD: -1 } }
        ];
        
        const summary = await AdRevenueEvent.aggregate(pipeline);
        
        // Calculate totals
        const totals = summary.reduce((acc, source) => ({
            totalRevenue: acc.totalRevenue + source.totalRevenueUSD,
            totalImpressions: acc.totalImpressions + source.impressions,
            totalPayout: acc.totalPayout + source.payout
        }), { totalRevenue: 0, totalImpressions: 0, totalPayout: 0 });
        
        res.json({
            summary,
            totals: {
                totalRevenueUSD: Math.round(totals.totalRevenue * 1000000) / 1000000,
                totalImpressions: totals.totalImpressions,
                totalPayoutUSD: Math.round(totals.totalPayout * 1000000) / 1000000,
                averageRevenuePerImpression: totals.totalImpressions > 0 
                    ? Math.round((totals.totalRevenue / totals.totalImpressions) * 100000000) / 100000000
                    : 0
            },
            dateRange: { from, to },
            currency
        });
        
    } catch (error) {
        console.error('❌ Error fetching ad revenue summary:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/events - Get recent ad revenue events (for debugging)
router.get('/events', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const skip = parseInt(req.query.skip) || 0;
        
        const events = await AdRevenueEvent.find({})
            .sort({ ts: -1 })
            .skip(skip)
            .limit(limit)
            .populate('sourceId', 'name groupName')
            .populate('articleId', 'title url');
            
        res.json({
            events,
            pagination: {
                limit,
                skip,
                hasMore: events.length === limit
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching ad revenue events:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
