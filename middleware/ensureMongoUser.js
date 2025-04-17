const User = require('../models/User')

module.exports = async (req, res, next) => {
    try {
        const supabase_id = req.user.sub
        let user = await User.findOne({ supabase_id })

        if (!user) {
            const { email, name, picture } = req.user

            user = await User.create({
                supabase_id,
                email: email || '',
                name: name || '',
                avatar_url: picture || '',
            })

            console.log('✅ MongoDB user created for Supabase ID:', supabase_id)
        }

        req.mongoUser = user // attach it for downstream handlers
        next()
    } catch (err) {
        console.error('🔥 ensureMongoUser error:', err)
        res.status(500).json({ message: 'Error checking/creating user' })
    }
}
