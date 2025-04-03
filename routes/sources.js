const express = require('express');
const router = express.Router();
const Source = require('../models/Source');

// Avoid redeclaring 'auth' if already declared elsewhere
let auth;
try {
    auth = require('../middleware/auth');
} catch (err) {
    console.warn('Auth middleware not found. Skipping auth.');
    auth = (_, __, next) => next();
}

router.get('/', auth, async (req, res) => {
    const sources = await Source.find();
    res.json(sources);
});

router.post('/', auth, async (req, res) => {
    try {
        const newSource = new Source(req.body);
        await newSource.save();
        res.status(201).json(newSource);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});
router.put('/:id', auth, async (req, res) => {
    try {
        const updated = await Source.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updated) return res.status(404).json({ message: 'Source not found' });
        res.json(updated);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});
router.delete('/:id', auth, async (req, res) => {
    try {
        const deleted = await Source.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Source not found' });
        res.json({ message: 'Source deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});


module.exports = router;