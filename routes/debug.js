const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

// Debug endpoint to test JWT authentication
router.get('/auth-test', auth, (req, res) => {
    console.log('🔍 DEBUG: Auth test endpoint reached');
    console.log('🔍 DEBUG: req.user:', JSON.stringify(req.user, null, 2));
    console.log('🔍 DEBUG: req.headers:', JSON.stringify(req.headers, null, 2));

    res.json({
        message: 'Authentication successful',
        user: req.user,
        headers: {
            authorization: req.headers.authorization ? 'present' : 'missing',
            'x-access-token': req.headers['x-access-token'] ? 'present' : 'missing'
        }
    });
});

module.exports = router;
