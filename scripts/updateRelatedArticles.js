// scripts/updateRelatedArticles.js
const mongoose = require('mongoose');
const Article = require('../models/Article');
const dotenv = require('dotenv'); // adjust to your DB connection
dotenv.config();

function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

async function updateAllRelatedArticles() {
    await mongoose.connect(process.env.MONGO_URI);

    const articles = await Article.find({ embedding: { $exists: true } });
    console.log(`Found ${articles.length} articles with embeddings`);

    for (const article of articles) {
        const similarities = articles
            .filter(a => a._id.toString() !== article._id.toString() && a.embedding?.length === article.embedding?.length)
            .map(other => ({
                id: other._id,
                similarity: cosineSimilarity(article.embedding, other.embedding),
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 5);

        const topIds = similarities.map(s => s.id);
        await Article.updateOne({ _id: article._id }, { relatedIds: topIds });
        console.log(`✅ Updated ${article.title} → ${topIds.length} related`);
    }

    console.log('🎉 All done.');
    process.exit();
}

updateAllRelatedArticles();
