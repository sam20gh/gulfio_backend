const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

module.exports = async (req, res, next) => {
    console.log('🔐 Auth middleware triggered');

    const apiKey = req.headers['x-api-key'];
    const hasAdminKey = apiKey === ADMIN_KEY;

    let token = null;

    if (req.headers['authorization']?.startsWith('Bearer ')) {
        token = req.headers['authorization'].split(' ')[1];
        console.log('🔍 Found Bearer token in Authorization header');
    } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
        console.log('🔍 Found token in x-access-token header');
    }

    // If we have a JWT token, always try to decode it to get user info
    // This is needed for user-specific endpoints even when admin key is present
    if (token) {
        try {
            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET, {
                    algorithms: ['HS256'],
                    issuer: SUPABASE_ISSUER,
                });
                console.log('✅ JWT verified successfully in auth middleware');
            } catch (verifyErr) {
                console.log('⚠️ JWT verification failed, trying decode only:', verifyErr.message);
                decoded = jwt.decode(token);
                if (!decoded) {
                    throw new Error('Invalid token structure - decode returned null');
                }
                console.log('ℹ️ Using unverified JWT decode in auth middleware');
            }

            req.user = decoded;
            console.log('🎯 Auth middleware: req.user set with sub:', req.user?.sub);
            return next();
        } catch (err) {
            console.error('❌ JWT processing failed:', err.message);
            // If admin key is present, allow through but without user context
            if (hasAdminKey) {
                console.log('⚠️ JWT failed but admin key present, continuing without user context');
                return next();
            }
            return res.status(403).json({
                message: 'Forbidden: Invalid token',
                error: process.env.NODE_ENV === 'development' ? err.message : undefined
            });
        }
    }

    // No JWT token - check for admin key only
    if (hasAdminKey) {
        console.log('✅ Using admin API key only (no JWT), skipping user context');
        return next();
    }

    console.error('❌ No token found in request headers');
    return res.status(401).json({ message: 'Unauthorized: Missing token' });
};
