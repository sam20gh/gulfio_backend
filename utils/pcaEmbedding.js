// utils/pcaEmbedding.js
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');
const Article = require('../models/Article');
const Reel = require('../models/Reel');

let globalPCA = null;

/**
 * Initialize the global PCA model from existing articles and reels
 */
async function initializePCAModel() {
    if (globalPCA) return globalPCA;

    try {
        console.log('🔄 Initializing PCA model from existing articles and reels...');

        // Get embeddings from both articles and reels
        const [sampleArticles, sampleReels] = await Promise.all([
            Article.find({
                embedding: { $exists: true, $ne: null }
            })
                .limit(3000) // Use max 3000 articles for PCA training
                .select('embedding')
                .lean(),
            Reel.find({
                embedding: { $exists: true, $ne: null }
            })
                .limit(2000) // Use max 2000 reels for PCA training
                .select('embedding')
                .lean()
        ]);

        const totalSamples = sampleArticles.length + sampleReels.length;
        console.log(`📊 Found ${sampleArticles.length} articles and ${sampleReels.length} reels for PCA training`);

        if (totalSamples < 50) {
            console.warn('⚠️ Not enough content to train PCA model');
            return null;
        }

        // Filter valid 1536D embeddings from both sources
        const validEmbeddings = [
            ...sampleArticles.map(a => a.embedding),
            ...sampleReels.map(r => r.embedding)
        ].filter(e => Array.isArray(e) && e.length === 1536);

        if (validEmbeddings.length < 50) {
            console.warn('⚠️ Not enough valid 1536D embeddings for PCA');
            return null;
        }

        console.log(`📊 Training PCA model with ${validEmbeddings.length} embeddings (${sampleArticles.length} articles + ${sampleReels.length} reels)...`);

        // Create matrix and train PCA
        console.log(`🔄 Creating matrix from ${validEmbeddings.length} x 1536 embeddings...`);
        const matrix = new Matrix(validEmbeddings);

        console.log(`🔄 Training PCA model...`);
        globalPCA = new PCA(matrix, { center: true, scale: false });

        console.log('✅ PCA model initialized successfully');
        console.log(`📊 PCA model stats: ${globalPCA.explained.length} components available`);
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
        console.log(`🔄 Converting 1536D embedding to 128D PCA...`);

        // Convert single embedding to matrix
        const inputMatrix = new Matrix([embedding]);
        console.log(`🔄 Created input matrix: ${inputMatrix.rows}x${inputMatrix.columns}`);

        // Apply PCA transformation
        const pcaResult = globalPCA.predict(inputMatrix, { nComponents: 128 });
        console.log(`🔄 PCA prediction completed: ${pcaResult.rows}x${pcaResult.columns}`);

        // Extract the 128D vector
        const pcaEmbedding = pcaResult.getRow(0);

        console.log(`✅ Converted 1536D → 128D embedding successfully`);
        return Array.from(pcaEmbedding);

    } catch (error) {
        console.error('❌ Error converting embedding to PCA:', {
            error: error.message,
            stack: error.stack,
            hasGlobalPCA: !!globalPCA,
            embeddingLength: embedding?.length
        });
        return null;
    }
}

module.exports = {
    initializePCAModel,
    convertToPCAEmbedding
};
