const User = require('../models/User')

module.exports = async (req, res, next) => {
    try {
        console.log('🔍 ensureMongoUser: Processing request');
        console.log('🔍 ensureMongoUser: Full req.user object:', JSON.stringify(req.user, null, 2));
        console.log('🔍 ensureMongoUser: req.user.sub:', req.user?.sub);
        console.log('🔍 ensureMongoUser: req.user keys:', req.user ? Object.keys(req.user) : 'no req.user');
        
        if (!req.user) {
            console.error('❌ ensureMongoUser: No req.user found');
            return res.status(400).json({ message: 'Invalid user data in token - no user object' });
        }
        
        if (!req.user.sub) {
            console.error('❌ ensureMongoUser: No user.sub in request');
            console.error('❌ ensureMongoUser: Available user fields:', Object.keys(req.user));
            return res.status(400).json({ message: 'Invalid user data in token - no sub field' });
        }

        const supabase_id = req.user.sub;
        console.log('👤 ensureMongoUser: Looking up user with Supabase ID:', supabase_id);
        
        let user = await User.findOne({ supabase_id });

        if (!user) {
            console.log('📝 ensureMongoUser: User not found, creating new user...');
            const { email, name, picture } = req.user;
            
            const userData = {
                supabase_id,
                email: email || '',
                name: name || '',
                avatar_url: picture || '',
            };
            
            console.log('🆕 ensureMongoUser: Creating user with data:', {
                supabase_id: userData.supabase_id,
                email: userData.email,
                name: userData.name,
                avatar_url: userData.avatar_url ? 'provided' : 'empty'
            });

            user = await User.create(userData);
            console.log('✅ ensureMongoUser: MongoDB user created for Supabase ID:', supabase_id, 'with MongoDB ID:', user._id);
        } else {
            console.log('✅ ensureMongoUser: Existing user found with MongoDB ID:', user._id);
        }

        req.mongoUser = user; // attach it for downstream handlers
        console.log('🎯 ensureMongoUser: User attached to request, proceeding to next middleware');
        next();
    } catch (err) {
        console.error('🔥 ensureMongoUser error details:');
        console.error('   - Error message:', err.message);
        console.error('   - Error name:', err.name);
        console.error('   - Error code:', err.code);
        if (err.errors) {
            console.error('   - Validation errors:', JSON.stringify(err.errors, null, 2));
        }
        console.error('   - Stack trace:', err.stack);
        console.error('   - Request user data:', JSON.stringify(req.user, null, 2));
        
        res.status(500).json({ 
            message: 'Error checking/creating user',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
}
