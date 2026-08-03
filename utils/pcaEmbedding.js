// utils/pcaEmbedding.js
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');
const Article = require('../models/Article');
const Reel = require('../models/Reel');
const PCAModel = require('../models/PCAModel');
const { fromVector, isValidEmbedding, vectorLength } = require('./vector');

let globalPCA = null;
// Single-flight lock: concurrent convertToPCAEmbedding() calls (e.g. a scraper batch)
// must share ONE initialization, not each kick off a corpus-scan training.
let initPromise = null;

const PCA_MODEL_NAME = 'article_embedding_pca_v1';

/**
 * Number of components we keep — matches the 128-dim `embedding_pca` Atlas index.
 *
 * This is also a hard storage requirement, not just a preference. PCA yields
 * min(samples, features) components, so training on more than 1536 samples produces a
 * 1536x1536 loadings matrix: 2.36M doubles ~= 18 MB, over MongoDB's 16 MB per-document
 * limit. Persisting the full model then fails with a Buffer "offset is out of range"
 * error. Keeping 128 columns brings it to ~1.6 MB.
 *
 * Truncation is lossless for our use: predict() multiplies by U and slices to
 * nComponents, so the first 128 columns give bit-identical output to slicing the full
 * matrix. S is left intact (it is ~12 KB) so getExplainedVariance() stays honest about
 * the share of total variance these components capture.
 */
const PCA_COMPONENTS = 128;

/**
 * Serialize a trained PCA, keeping only PCA_COMPONENTS columns of the loadings matrix.
 * Returns a plain JSON object ready for Mongo (Matrix instances become arrays).
 */
function serializeTruncated(pca) {
    const json = pca.toJSON();
    const U = Matrix.checkMatrix(json.U);
    if (U.columns > PCA_COMPONENTS) {
        json.U = U.subMatrix(0, U.rows - 1, 0, PCA_COMPONENTS - 1);
    }
    return JSON.parse(JSON.stringify(json));
}

/**
 * Persist a trained model and adopt the persisted form in memory, so this process
 * projects through exactly the same basis every other process will load.
 */
async function persistPCA(pca, sampleCount) {
    const serialized = serializeTruncated(pca);
    const kept = Matrix.checkMatrix(serialized.U).columns;
    // Share of total variance captured, computed before truncation.
    const variance = pca.getExplainedVariance();
    const explained = variance.slice(0, kept).reduce((a, b) => a + b, 0);

    await PCAModel.updateOne(
        { name: PCA_MODEL_NAME },
        {
            $set: {
                name: PCA_MODEL_NAME,
                model: serialized,
                components: kept,
                explainedVariance: explained,
                sampleCount,
                trainedAt: new Date(),
            },
        },
        { upsert: true }
    );

    globalPCA = PCA.load(serialized);
    console.log(
        `💾 Persisted PCA "${PCA_MODEL_NAME}" — ${kept} components ` +
        `from ${sampleCount} samples, ${(explained * 100).toFixed(1)}% of total variance`
    );
    return globalPCA;
}

/**
 * Train a fresh PCA model from the current article+reel corpus.
 * Does NOT persist — caller decides. Returns null if there isn't enough
 * data to train (<50 valid 1536D embeddings).
 */
async function trainPCAFromCorpus({ articleSamples = 3000, reelSamples = 2000 } = {}) {
    console.log(`🔄 Training PCA from current article+reel corpus (${articleSamples} articles, ${reelSamples} reels)...`);

    // NOTE: { embedding: { $exists } } cannot use an index (embedding is a 1536-float
    // array; a btree on it is multikey bloat). These are deliberately bounded collscans.
    // maxTimeMS caps them so a slow/overloaded cluster fails fast instead of letting
    // concurrent cold-start trainings pile up and saturate CPU. The persisted PCA model
    // (see initializePCAModel) means this should run at most once per basis, not per boot.
    const [sampleArticles, sampleReels] = await Promise.all([
        Article.find({ embedding: { $exists: true, $ne: null } })
            .limit(articleSamples)
            .select('embedding')
            .maxTimeMS(45000)
            .lean(),
        Reel.find({ embedding: { $exists: true, $ne: null } })
            .limit(reelSamples)
            .select('embedding')
            .maxTimeMS(45000)
            .lean(),
    ]);

    console.log(`📊 Found ${sampleArticles.length} articles + ${sampleReels.length} reels`);

    // Articles store `embedding` as a BSON Binary float32 vector, reels still as an
    // array of doubles. fromVector normalises both to number[] for the PCA matrix.
    const validEmbeddings = [
        ...sampleArticles.map((a) => a.embedding),
        ...sampleReels.map((r) => r.embedding),
    ]
        .filter((e) => isValidEmbedding(e))
        .map((e) => fromVector(e));

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
            await persistPCA(trained.pca, trained.sampleCount);
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
async function retrainAndPersistPCA(sampleOpts) {
    const trained = await trainPCAFromCorpus(sampleOpts);
    if (!trained) {
        return { success: false, error: 'Not enough corpus to train' };
    }
    await persistPCA(trained.pca, trained.sampleCount);
    console.log(`🔁 PCA retrained + persisted (${trained.sampleCount} samples)`);
    return {
        success: true,
        components: Matrix.checkMatrix(globalPCA.U).columns,
        sampleCount: trained.sampleCount,
    };
}

/**
 * Convert a 1536D embedding to 128D using the global PCA model
 * @param {Array|Binary} embedding - 1536D embedding, array or BSON Binary float32 vector
 * @returns {Array} 128D PCA embedding or null if failed
 */
async function convertToPCAEmbedding(embedding) {
    if (!isValidEmbedding(embedding)) {
        console.warn('⚠️ Invalid embedding for PCA conversion');
        return null;
    }
    const embeddingValues = fromVector(embedding);

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
        const inputMatrix = new Matrix([embeddingValues]);
        console.log(`🔄 Created input matrix: ${inputMatrix.rows}x${inputMatrix.columns}`);

        // Apply PCA transformation. Clamp to the model's actual width: a rank-limited
        // model (trained when the corpus was small) can have fewer columns than
        // PCA_COMPONENTS, and predict() would throw slicing past the end.
        const available = Matrix.checkMatrix(globalPCA.U).columns;
        const pcaResult = globalPCA.predict(inputMatrix, {
            nComponents: Math.min(PCA_COMPONENTS, available),
        });
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
            embeddingLength: vectorLength(embedding)
        });
        return null;
    }
}

module.exports = {
    initializePCAModel,
    convertToPCAEmbedding,
    retrainAndPersistPCA,
};
