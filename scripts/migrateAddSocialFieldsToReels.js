const mongoose = require('mongoose');
const Reel = require('../models/Reel');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/YOUR_DB_NAME'; // edit as needed

async function migrate() {
    await mongoose.connect(MONGO_URI);

    const reels = await Reel.find();
    let updated = 0;

    for (const reel of reels) {
        let changed = false;

        if (typeof reel.likes !== 'number') { reel.likes = 0; changed = true; }
        if (!Array.isArray(reel.likedBy)) { reel.likedBy = []; changed = true; }
        if (typeof reel.dislikes !== 'number') { reel.dislikes = 0; changed = true; }
        if (!Array.isArray(reel.dislikedBy)) { reel.dislikedBy = []; changed = true; }
        if (typeof reel.viewCount !== 'number') { reel.viewCount = 0; changed = true; }
        if (!Array.isArray(reel.viewedBy)) { reel.viewedBy = []; changed = true; }

        if (changed) {
            await reel.save();
            updated++;
            console.log(`Updated reel: ${reel._id}`);
        }
    }

    console.log(`Migration complete. Updated ${updated} reel(s).`);
    mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Migration error:', err);
    mongoose.disconnect();
});
