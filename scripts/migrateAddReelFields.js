// scripts/migrateAddReelFields.js

const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/YOUR_DB_NAME'; // update if needed

async function migrate() {
    await mongoose.connect(MONGO_URI);
    const users = await User.find();

    let updated = 0;

    for (const user of users) {
        let changed = false;
        if (!Array.isArray(user.liked_reels)) {
            user.liked_reels = [];
            changed = true;
        }
        if (!Array.isArray(user.disliked_reels)) {
            user.disliked_reels = [];
            changed = true;
        }
        if (!Array.isArray(user.saved_reels)) {
            user.saved_reels = [];
            changed = true;
        }
        if (!Array.isArray(user.viewed_reels)) {
            user.viewed_reels = [];
            changed = true;
        }
        if (changed) {
            await user.save();
            updated++;
            console.log(`Updated user: ${user._id}`);
        }
    }

    console.log(`Migration complete. Updated ${updated} user(s).`);
    mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Migration error:', err);
    mongoose.disconnect();
});
