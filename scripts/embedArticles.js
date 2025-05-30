const mongoose = require('mongoose');
const Article = require('../models/Article');
const { getDeepSeekEmbedding } = require('../utils/deepseek');

async function embedAllArticles() {
    await mongoose.connect(process.env.MONGODB_URI);
    const articles = await Article.find({ $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }] });

    for (let article of articles) {
        const text = `${article.title}\n\n${article.content?.slice(0, 512) || ''}`;
        try {
            article.embedding = await getDeepSeekEmbedding(text);
            await article.save();
            console.log(`✅ Embedded: ${article.title}`);
        } catch (err) {
            console.error(`❌ Error embedding article ${article._id}:`, err.message);
        }
    }
    mongoose.disconnect();
}
embedAllArticles();
