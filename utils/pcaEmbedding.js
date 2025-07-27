// utils/pcaEmbedding.js
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');
const Article = require('../models/Article');

let globalPCA = null;

/**
 * Initialize the global PCA model from existing articles
 */
async function initializePCAModel() {
    if (globalPCA) return globalPCA;

    try {
        console.log('🔄 Initializing PCA model from existing articles...');

        // Get a sample of existing articles with embeddings for PCA training
        const sampleArticles = await Article.find({
            embedding: { $exists: true, $ne: null }
        })
            .limit(5000) // Use max 5000 articles for PCA training
            .select('embedding')
            .lean();

        if (sampleArticles.length < 100) {
            console.warn('⚠️ Not enough articles to train PCA model');
            return null;
        }

        // Filter valid 1536D embeddings
        const validEmbeddings = sampleArticles
            .map(a => a.embedding)
            .filter(e => Array.isArray(e) && e.length === 1536);

        if (validEmbeddings.length < 100) {
            console.warn('⚠️ Not enough valid 1536D embeddings for PCA');
            return null;
        }

        console.log(`📊 Training PCA model with ${validEmbeddings.length} embeddings...`);

        // Create matrix and train PCA
        const matrix = new Matrix(validEmbeddings);
        globalPCA = new PCA(matrix, { center: true, scale: false });

        console.log('✅ PCA model initialized successfully');
        return globalPCA;

    } catch (error) {
        console.error('❌ Error initializing PCA model:', error);
        return null;
    }
}

/**
 * Convert a 1536D embedding to 128D using the global PCA model
 * @param {Array} embedding - 1536D embedding array
 * @returns {Array} 128D PCA embedding or null if failed
 */
async function convertToPCAEmbedding(embedding) {
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
        console.warn('⚠️ Invalid embedding for PCA conversion');
        return null;
    }

    // Initialize PCA model if not already done
    if (!globalPCA) {
        await initializePCAModel();
    }

    if (!globalPCA) {
        console.warn('⚠️ PCA model not available for embedding conversion');
        return null;
    }

    try {
        // Convert single embedding to matrix
        const inputMatrix = new Matrix([embedding]);

        // Apply PCA transformation
        const pcaResult = globalPCA.predict(inputMatrix, { nComponents: 128 });

        // Extract the 128D vector
        const pcaEmbedding = pcaResult.getRow(0);

        console.log(`✅ Converted 1536D → 128D embedding`);
        return Array.from(pcaEmbedding);

    } catch (error) {
        console.error('❌ Error converting embedding to PCA:', error);
        return null;
    }
}

module.exports = {
    initializePCAModel,
    convertToPCAEmbedding
};
