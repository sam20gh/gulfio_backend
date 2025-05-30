const User = require('../models/User');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

async function batchUpdateUserEmbeddings() {
    const users = await User.find({});
    for (let user of users) {
        try {
            await updateUserProfileEmbedding(user._id);
            console.log(`✅ Updated embedding for user ${user.email || user.supabase_id}`);
        } catch (err) {
            console.error(`❌ Failed for user ${user._id}:`, err.message);
        }
    }
    process.exit(0);
}

batchUpdateUserEmbeddings();
