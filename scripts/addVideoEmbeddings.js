const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const Video = require('../models/Video');

dotenv.config();

async function addEmbeddingsToVideos() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Fetch videos with no embedding
        const videos = await Video.find({
            $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }],
        });

        console.log(`🎥 Found ${videos.length} videos missing embeddings`);

        for (const video of videos) {
            const input = `${video.title ?? ''}. ${video.description ?? ''}`.trim();
            if (!input) {
                console.warn(`⚠️ Skipping video ${video._id} due to empty input`);
                continue;
            }

            try {
                const embedding = await getDeepSeekEmbedding(input);
                if (Array.isArray(embedding)) {
                    video.embedding = embedding;
                    await video.save();
                    console.log(`✅ Embedded video ${video._id} – "${video.title}"`);
                } else {
                    console.warn(`⚠️ Invalid embedding for video ${video._id}`);
                }
            } catch (err) {
                console.error(`❌ Failed embedding for ${video._id}: ${err.message}`);
            }
        }

        console.log('🎉 Embedding process completed');
        await mongoose.disconnect();
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

addEmbeddingsToVideos();
