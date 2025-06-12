const mongoose = require('mongoose');
const Reel = require('../models/Reel');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/YOUR_DB_NAME';

async function migrate() {
    await mongoose.connect(MONGO_URI);

    const reels = await Reel.find();
    let updated = 0;

    for (const reel of reels) {
        let changed = false;

        // Use "in" to check for presence in raw doc, NOT Mongoose virtuals/defaults
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'likes')) {
            reel.likes = 0; changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'likedBy')) {
            reel.likedBy = []; changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'dislikes')) {
            reel.dislikes = 0; changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'dislikedBy')) {
            reel.dislikedBy = []; changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'viewCount')) {
            reel.viewCount = 0; changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(reel.toObject(), 'viewedBy')) {
            reel.viewedBy = []; changed = true;
        }

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
