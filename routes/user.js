const express = require('express');
const router = express.Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

router.post('/check-or-create', auth, async (req, res) => {
    try {
        const supabase_id = req.user.sub;
        const { email, name, picture } = req.user;

        let user = await User.findOne({ supabase_id });
        if (!user) {
            user = await User.create({
                supabase_id,
                email,
                name,
                avatar_url: picture
            });
        }

        res.json(user);
    } catch (err) {
        console.error('User creation error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
