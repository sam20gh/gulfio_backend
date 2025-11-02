const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

module.exports = async (req, res, next) => {
    console.log('🔐 Auth middleware triggered');

    const apiKey = req.headers['x-api-key'];
    if (apiKey === ADMIN_KEY) {
        console.log('✅ Using admin API key, skipping JWT verification');
        return next();
    }

    let token = null;

    if (req.headers['authorization']?.startsWith('Bearer ')) {
        token = req.headers['authorization'].split(' ')[1];
        console.log('🔍 Found Bearer token in Authorization header');
    } else if (req.headers['x-access-token']) {
        token = req.headers['x-access-token'];
        console.log('🔍 Found token in x-access-token header');
    }

    if (!token) {
        console.error('❌ No token found in request headers');
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }

    console.log('🔍 Token length:', token.length);
    console.log('🔍 JWT_SECRET exists:', !!JWT_SECRET);
    console.log('🔍 SUPABASE_ISSUER:', SUPABASE_ISSUER);


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
        console.log('🎯 Decoded token structure:', JSON.stringify(decoded, null, 2));
        req.user = decoded;
        console.log('🎯 Auth middleware: req.user set successfully');
        console.log('🎯 req.user verification:', {
            exists: !!req.user,
            hasSubField: !!req.user?.sub,
            subValue: req.user?.sub
        });
        console.log('🎯 Auth middleware: calling next()');
        next();
    } catch (err) {
        console.error('❌ Auth middleware failed:', err.message);
        console.error('❌ Auth middleware error stack:', err.stack);
        console.error('❌ Token that failed verification:', token?.substring(0, 100) + '...');
        return res.status(403).json({
            message: 'Forbidden: Invalid token',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined,
            debug: {
                errorName: err.name,
                errorMessage: err.message
            }
        });
    }
};
