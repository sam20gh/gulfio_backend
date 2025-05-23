// routes/lotto.js
const express = require('express');
const LottoResult = require('../models/LottoResult');
const router = express.Router();

// GET latest draw
router.get('/latest', async (req, res) => {
    const result = await LottoResult.findOne().sort({ scrapedAt: -1 });
    if (!result) return res.status(404).json({ error: 'No result found' });
    res.json(result);
});

// GET by draw number
router.get('/:drawNumber', async (req, res) => {
    const result = await LottoResult.findOne({ drawNumber: req.params.drawNumber });
    if (!result) return res.status(404).json({ error: 'No result for that draw' });
    res.json(result);
});

module.exports = router;
