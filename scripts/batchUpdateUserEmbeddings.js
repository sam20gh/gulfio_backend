const mongoose = require('mongoose');
require('dotenv').config(); // Only if you use .env for your MONGO_URI

async function main() {
    await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });

    const User = require('../models/User');
    const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

    const users = await User.find({});
    for (let user of users) {
        try {
            await updateUserProfileEmbedding(user._id);
            console.log(`✅ Updated embedding for user ${user.email || user.supabase_id}`);
        } catch (err) {
            console.error(`❌ Failed for user ${user._id}:`, err.message);
        }
    }
    await mongoose.disconnect();
    process.exit(0);
}

main();
