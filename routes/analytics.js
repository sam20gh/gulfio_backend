// routes/analytics.js
const express = require('express');

const router = express.Router();

// POST /api/analytics/performance — app-side performance metrics flush (utils/performance.ts).
// Accept-and-log only for now; no auth requirement since it's fire-and-forget telemetry
// and the client may not always have a session yet.
router.post('/performance', (req, res) => {
    const { timestamp, stats, deviceInfo } = req.body || {};

    console.log('⚡ [analytics/performance] received metrics flush', {
        timestamp,
        platform: deviceInfo?.platform,
        version: deviceInfo?.version,
        statKeys: stats ? Object.keys(stats) : [],
    });

    res.status(200).json({ received: true });
});

module.exports = router;
