#!/usr/bin/env node
/**
 * Backfill Embeddings Script
 * 
 * This script backfills missing embeddings and embedding_pca for articles.
 * 
 * IMPORTANT: Before running, ensure:
 * 1. OPENAI_API_KEY has sufficient quota/billing
 * 2. Test with --dry-run first
 * 
 * Usage:
 *   node backfill-embeddings.js                    # Process missing embeddings
 *   node backfill-embeddings.js --dry-run          # Test without making changes
 *   node backfill-embeddings.js --batch-size=50    # Custom batch size
 *   node backfill-embeddings.js --limit=1000       # Limit total articles processed
 *   node backfill-embeddings.js --pca-only         # Only generate PCA for articles with embedding
 *   node backfill-embeddings.js --recent-days=7    # Only process articles from last N days
 * 
 * @author Gulfio Backend Team
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

// Configuration
const CONFIG = {
    OPENAI_API_URL: 'https://api.openai.com/v1/embeddings',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEFAULT_MODEL: 'text-embedding-3-small',
    BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 20, // Articles per batch
    API_DELAY_MS: 200, // Delay between API calls to respect rate limits
    BATCH_DELAY_MS: 2000, // Delay between batches
    MAX_RETRIES: 3,
    PCA_DIMENSIONS: 128,
};

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const pcaOnly = args.includes('--pca-only');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const limitArg = args.find(a => a.startsWith('--limit='));
const recentDaysArg = args.find(a => a.startsWith('--recent-days='));

const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : CONFIG.BATCH_SIZE;
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const RECENT_DAYS = recentDaysArg ? parseInt(recentDaysArg.split('=')[1]) : null;

// PCA dependencies (lazy loaded)
let PCA = null;
let Matrix = null;
let globalPCA = null;

/**
 * Get embedding from OpenAI API
 */
async function getEmbedding(text, retries = 0) {
    if (!CONFIG.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not set');
    }

    try {
        const response = await axios.post(
            CONFIG.OPENAI_API_URL,
            {
                model: CONFIG.DEFAULT_MODEL,
                input: [text]
            },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        if (response.data?.data?.[0]?.embedding) {
            return response.data.data[0].embedding;
        }
        throw new Error('Invalid response from OpenAI API');
    } catch (err) {
        const isRateLimit = err.response?.status === 429;
        const isQuotaError = err.response?.data?.error?.code === 'insufficient_quota';
        
        if (isQuotaError) {
            console.error('\n❌ OpenAI API quota exceeded! Please add billing/credits.');
            console.error('   Visit: https://platform.openai.com/account/billing');
            process.exit(1);
        }

        if (isRateLimit && retries < CONFIG.MAX_RETRIES) {
            const delay = Math.pow(2, retries) * 1000;
            console.log(`⏳ Rate limited, waiting ${delay}ms before retry ${retries + 1}/${CONFIG.MAX_RETRIES}`);
            await sleep(delay);
            return getEmbedding(text, retries + 1);
        }

        throw err;
    }
}

/**
 * Initialize PCA model from existing embeddings
 */
async function initializePCAModel(Article) {
    if (globalPCA) return globalPCA;
    if (isDryRun) {
        console.log('⏭️ Skipping PCA initialization for dry run');
        return null;
    }

    // Lazy load PCA dependencies
    if (!PCA) {
        try {
            const mlPca = require('ml-pca');
            const mlMatrix = require('ml-matrix');
            PCA = mlPca.PCA;
            Matrix = mlMatrix.Matrix;
        } catch (err) {
            console.error('❌ Failed to load ml-pca. Install with: npm install ml-pca ml-matrix');
            return null;
        }
    }

    console.log('🔄 Initializing PCA model from existing articles...');

    const sampleArticles = await Article.find({
        'embedding.0': { $exists: true }
    })
    .sort({ _id: -1 }) // Use indexed _id field for faster query
    .limit(3000)
    .select('embedding')
    .lean();

    console.log(`📊 Found ${sampleArticles.length} articles with embeddings for PCA training`);

    if (sampleArticles.length < 50) {
        console.warn('⚠️ Not enough articles to train PCA model (need at least 50)');
        return null;
    }

    const validEmbeddings = sampleArticles
        .map(a => a.embedding)
        .filter(e => Array.isArray(e) && e.length === 1536);

    if (validEmbeddings.length < 50) {
        console.warn('⚠️ Not enough valid 1536D embeddings for PCA');
        return null;
    }

    console.log(`📊 Training PCA model with ${validEmbeddings.length} embeddings...`);
    const matrix = new Matrix(validEmbeddings);
    globalPCA = new PCA(matrix, { center: true, scale: false });
    console.log('✅ PCA model initialized successfully');
    
    return globalPCA;
}

/**
 * Convert 1536D embedding to 128D PCA embedding
 */
function convertToPCAEmbedding(embedding) {
    if (!globalPCA || !Array.isArray(embedding) || embedding.length !== 1536) {
        return null;
    }

    try {
        const inputMatrix = new Matrix([embedding]);
        const pcaResult = globalPCA.predict(inputMatrix, { nComponents: CONFIG.PCA_DIMENSIONS });
        return Array.from(pcaResult.getRow(0));
    } catch (err) {
        console.error('❌ PCA conversion error:', err.message);
        return null;
    }
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clean text for embedding generation
 */
function prepareEmbeddingInput(article) {
    const title = article.title || '';
    let content = article.content || '';
    
    // Strip HTML and iframes
    content = content
        .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
        .replace(/<[^>]*>/g, '')
        .trim();
    
    // Combine title and first 512 chars of content
    return `${title}\n\n${content.slice(0, 512)}`;
}

/**
 * Main backfill function
 */
async function backfillEmbeddings() {
    console.log('🚀 Embedding Backfill Script');
    console.log('='.repeat(50));
    console.log(`📋 Configuration:`);
    console.log(`   Dry run: ${isDryRun}`);
    console.log(`   PCA only: ${pcaOnly}`);
    console.log(`   Batch size: ${BATCH_SIZE}`);
    console.log(`   Limit: ${LIMIT || 'None'}`);
    console.log(`   Recent days: ${RECENT_DAYS || 'All'}`);
    console.log('='.repeat(50));

    // Test OpenAI API first
    if (!isDryRun && !pcaOnly) {
        console.log('\n🔍 Testing OpenAI API connection...');
        try {
            await getEmbedding('test');
            console.log('✅ OpenAI API is working!');
        } catch (err) {
            console.error('❌ OpenAI API test failed:', err.response?.data?.error || err.message);
            process.exit(1);
        }
    }

    // Connect to MongoDB
    console.log('\n🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
    });
    console.log('✅ Connected to MongoDB');

    const Article = require('./models/Article');

    // Build query for articles needing embeddings
    let query = {};
    
    if (pcaOnly) {
        // Articles with embedding but missing PCA
        query = {
            'embedding.0': { $exists: true },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { 'embedding_pca.0': { $exists: false } }
            ]
        };
    } else {
        // Articles missing embedding
        query = {
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { 'embedding.0': { $exists: false } }
            ]
        };
    }

    // Add date filter if specified
    if (RECENT_DAYS) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - RECENT_DAYS);
        query.publishedAt = { $gte: cutoffDate };
    }

    // Skip the slow count operation - just process articles in batches
    // The count on embedding field without index is too slow for 160k+ articles
    console.log('📊 Will process articles in batches (skipping slow count operation)');
    const totalToProcess = LIMIT || 'unknown';
    console.log(`   Limit: ${LIMIT ? LIMIT + ' articles' : 'No limit (all missing)'}`);

    // Initialize PCA model (skipped for dry run)
    if (!isDryRun) {
        await initializePCAModel(Article);
    } else {
        console.log('⏭️ Skipping PCA initialization for dry run');
    }

    // Process in batches
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const startTime = Date.now();

    while (true) {
        // Check limit
        if (LIMIT && processed >= LIMIT) {
            console.log(`\n🛑 Reached limit of ${LIMIT} articles`);
            break;
        }

        // Fetch batch
        const batchLimit = LIMIT ? Math.min(BATCH_SIZE, LIMIT - processed) : BATCH_SIZE;
        const articles = await Article.find(query)
            .sort({ publishedAt: -1 })
            .limit(batchLimit)
            .select('_id title content embedding')
            .lean();

        if (articles.length === 0) {
            break;
        }

        console.log(`\n📦 Processing batch of ${articles.length} articles (${processed + 1}-${processed + articles.length})`);

        for (const article of articles) {
            try {
                const updates = {};

                if (pcaOnly) {
                    // Only generate PCA
                    if (article.embedding && article.embedding.length === 1536) {
                        const pcaEmbedding = convertToPCAEmbedding(article.embedding);
                        if (pcaEmbedding) {
                            updates.embedding_pca = pcaEmbedding;
                        }
                    }
                } else {
                    // Generate both embedding and PCA
                    const input = prepareEmbeddingInput(article);
                    
                    if (!input || input.length < 10) {
                        console.log(`⏭️ Skipping "${article.title?.slice(0, 30)}..." - insufficient content`);
                        skipped++;
                        continue;
                    }

                    if (!isDryRun) {
                        const embedding = await getEmbedding(input);
                        updates.embedding = embedding;

                        // Generate PCA embedding
                        if (embedding && embedding.length === 1536 && globalPCA) {
                            const pcaEmbedding = convertToPCAEmbedding(embedding);
                            if (pcaEmbedding) {
                                updates.embedding_pca = pcaEmbedding;
                            }
                        }

                        // Delay between API calls
                        await sleep(CONFIG.API_DELAY_MS);
                    }
                }

                // Update article
                if (Object.keys(updates).length > 0 && !isDryRun) {
                    await Article.updateOne({ _id: article._id }, { $set: updates });
                }

                succeeded++;
                process.stdout.write(`✅ `);

            } catch (err) {
                failed++;
                console.error(`\n❌ Failed "${article.title?.slice(0, 30)}...": ${err.message}`);
            }

            processed++;
        }

        // Progress update
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = processed / elapsed;
        console.log(`\n📈 Progress: ${processed} processed`);
        console.log(`   Rate: ${rate.toFixed(1)} articles/sec, Elapsed: ${Math.ceil(elapsed/60)} minutes`);

        // Batch delay
        await sleep(CONFIG.BATCH_DELAY_MS);
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`   Total processed: ${processed}`);
    console.log(`   Succeeded: ${succeeded}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Duration: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);

    if (isDryRun) {
        console.log('\n⚠️ This was a DRY RUN - no changes were made');
    }

    await mongoose.disconnect();
    console.log('\n✅ Done!');
}

// Run the script
backfillEmbeddings().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
