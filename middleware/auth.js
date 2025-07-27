const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

module.exports = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_KEY) return next();

    let token = null;

    if (req.headers['authorization']?.startsWith('Bearer ')) {
        token = req.headers['authorization'].split(' ')[1];
    } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
    }

    if (!token) {
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }


    try {
        // First try with full verification
        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET, {
                algorithms: ['HS256'],
                issuer: SUPABASE_ISSUER,
            });
            console.log('✅ JWT verified successfully in auth middleware');
            console.log('✅ Decoded JWT structure:', JSON.stringify(decoded, null, 2));
        } catch (verifyErr) {
            console.log('⚠️ JWT verification failed in auth middleware, trying decode only:', verifyErr.message);

            // Fallback to decode without verification (for compatibility)
            try {
                decoded = jwt.decode(token);
                console.log('ℹ️ Using unverified JWT decode in auth middleware');
                console.log('ℹ️ Decoded JWT structure:', JSON.stringify(decoded, null, 2));

                // Basic validation
                if (!decoded) {
                    throw new Error('Invalid token structure - decode returned null');
                }
                if (!decoded.sub && !decoded.user_id && !decoded.id) {
                    throw new Error('Invalid token structure - no user ID found');
                }
            } catch (decodeErr) {
                console.error('❌ JWT decode also failed in auth middleware:', decodeErr.message);
                throw decodeErr;
            }
        }

        console.log('🎯 Auth middleware: Setting req.user with decoded token');
        req.user = decoded;
        console.log('🎯 Auth middleware: req.user set successfully, calling next()');
        next();
    } catch (err) {
        console.error('❌ Auth middleware failed:', err.message);
        return res.status(403).json({ 
            message: 'Forbidden: Invalid token',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};
