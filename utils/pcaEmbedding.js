// utils/pcaEmbedding.js
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');
const Article = require('../models/Article');
const Reel = require('../models/Reel');
const PCAModel = require('../models/PCAModel');

let globalPCA = null;
// Single-flight lock: concurrent convertToPCAEmbedding() calls (e.g. a scraper batch)
// must share ONE initialization, not each kick off a corpus-scan training.
let initPromise = null;

const PCA_MODEL_NAME = 'article_embedding_pca_v1';

/**
 * Train a fresh PCA model from the current article+reel corpus.
 * Does NOT persist — caller decides. Returns null if there isn't enough
 * data to train (<50 valid 1536D embeddings).
 */
async function trainPCAFromCorpus() {
    console.log('🔄 Training PCA from current article+reel corpus...');

    // NOTE: { embedding: { $exists } } cannot use an index (embedding is a 1536-float
    // array; a btree on it is multikey bloat). These are deliberately bounded collscans.
    // maxTimeMS caps them so a slow/overloaded cluster fails fast instead of letting
    // concurrent cold-start trainings pile up and saturate CPU. The persisted PCA model
    // (see initializePCAModel) means this should run at most once per basis, not per boot.
    const [sampleArticles, sampleReels] = await Promise.all([
        Article.find({ embedding: { $exists: true, $ne: null } })
            .limit(3000)
            .select('embedding')
            .maxTimeMS(45000)
            .lean(),
        Reel.find({ embedding: { $exists: true, $ne: null } })
            .limit(2000)
            .select('embedding')
            .maxTimeMS(45000)
            .lean(),
    ]);

    console.log(`📊 Found ${sampleArticles.length} articles + ${sampleReels.length} reels`);

    const validEmbeddings = [
        ...sampleArticles.map((a) => a.embedding),
        ...sampleReels.map((r) => r.embedding),
    ].filter((e) => Array.isArray(e) && e.length === 1536);

    if (validEmbeddings.length < 50) {
        console.warn('⚠️ Not enough valid 1536D embeddings for PCA training');
        return null;
    }

    console.log(`📊 Training PCA with ${validEmbeddings.length} embeddings...`);
    const matrix = new Matrix(validEmbeddings);
    const pca = new PCA(matrix, { center: true, scale: false });
    console.log(`✅ PCA trained — ${pca.getExplainedVariance().length} components`);
    return { pca, sampleCount: validEmbeddings.length };
}

/**
 * Initialize the global PCA model.
 *
 * Tries to load a persisted model from Mongo first (P3-3) — this keeps
 * the 128-D basis stable across deploys / restarts so every embedding
 * ever produced lives in the same space. Only trains from the corpus
 * on a true cold start (no persisted model exists yet).
 */
async function initializePCAModel() {
    if (globalPCA) return globalPCA;
    // Coalesce concurrent initializations into a single in-flight attempt.
    if (initPromise) return initPromise;
    initPromise = _initializePCAModel().finally(() => { initPromise = null; });
    return initPromise;
}

async function _initializePCAModel() {
    if (globalPCA) return globalPCA;

    try {
        // 1. Load persisted model if present.
        const persisted = await PCAModel.findOne({ name: PCA_MODEL_NAME }).lean();
        if (persisted?.model) {
            try {
                globalPCA = PCA.load(persisted.model);
                console.log(
                    `✅ PCA loaded from Mongo ` +
                    `(${persisted.components || '?'} components, ` +
                    `trained ${persisted.trainedAt?.toISOString?.() || 'unknown'} ` +
                    `on ${persisted.sampleCount || '?'} samples)`
                );
                return globalPCA;
            } catch (loadErr) {
                console.warn(
                    '⚠️ Persisted PCA failed to hydrate, will retrain:',
                    loadErr.message
                );
            }
        } else {
            console.log('ℹ️ No persisted PCA found — training fresh from corpus');
        }

        // 2. Fall back to training from current corpus.
        const trained = await trainPCAFromCorpus();
        if (!trained) return null;

        globalPCA = trained.pca;

        // 3. Persist so subsequent boots are deterministic.
        try {
            await PCAModel.updateOne(
                { name: PCA_MODEL_NAME },
                {
                    $set: {
                        name: PCA_MODEL_NAME,
                        model: JSON.parse(JSON.stringify(globalPCA.toJSON())),
                        components: globalPCA.getExplainedVariance().length,
                        sampleCount: trained.sampleCount,
                        trainedAt: new Date(),
                    },
                },
                { upsert: true }
            );
            console.log(`💾 Persisted PCA model to Mongo as "${PCA_MODEL_NAME}"`);
        } catch (saveErr) {
            console.error('⚠️ Failed to persist PCA model:', saveErr.message);
            // Non-fatal: the in-memory model still works for this process.
        }

        return globalPCA;
    } catch (error) {
        console.error('❌ Error initializing PCA model:', error);
        return null;
    }
}

/**
 * Force a retrain from the current corpus and overwrite the persisted
 * model. Use after a known content distribution shift (e.g. major new
 * sources added, language mix changed significantly).
 *
 * WARNING: invalidates the 128-D basis. All previously-generated
 * embedding_pca values become stale and should be regenerated.
 */
async function retrainAndPersistPCA() {
    const trained = await trainPCAFromCorpus();
    if (!trained) {
        return { success: false, error: 'Not enough corpus to train' };
    }
    globalPCA = trained.pca;
    await PCAModel.updateOne(
        { name: PCA_MODEL_NAME },
        {
            $set: {
                name: PCA_MODEL_NAME,
                model: JSON.parse(JSON.stringify(globalPCA.toJSON())),
                components: globalPCA.getExplainedVariance().length,
                sampleCount: trained.sampleCount,
                trainedAt: new Date(),
            },
        },
        { upsert: true }
    );
    console.log(`🔁 PCA retrained + persisted (${trained.sampleCount} samples)`);
    return {
        success: true,
        components: globalPCA.getExplainedVariance().length,
        sampleCount: trained.sampleCount,
    };
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
    convertToPCAEmbedding,
    retrainAndPersistPCA,
};
