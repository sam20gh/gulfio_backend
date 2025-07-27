const faiss = require('faiss-node');
const { Matrix } = require('ml-matrix');
const Article = require('../models/Article');

let faissIndex = null;
let articleIds = [];
let isInitializing = false;
const ORIGINAL_DIMENSIONS = 1536;
const REDUCED_DIMENSIONS = 128;

/**
 * Initialize Faiss index with PCA embeddings from articles
 */
async function initializeFaissIndex() {
  if (isInitializing) {
    console.log('⏳ Faiss index initialization already in progress...');
    return;
  }

  isInitializing = true;
  
  try {
    console.log('🚀 Initializing Faiss index...');
    
    // Fetch articles with PCA embeddings
    const articles = await Article.find({ 
      embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } } 
    })
      .select('_id embedding_pca')
      .lean()
      .maxTimeMS(60000); // 60-second timeout

    console.log(`📊 Found ${articles.length} articles with PCA embeddings`);

    if (articles.length === 0) {
      console.error('❌ No articles with PCA embeddings found');
      return;
    }

    // Filter valid PCA embeddings
    const validArticles = articles.filter(a => 
      Array.isArray(a.embedding_pca) && a.embedding_pca.length === REDUCED_DIMENSIONS
    );

    console.log(`✅ Found ${validArticles.length} valid PCA embeddings`);

    if (validArticles.length === 0) {
      console.error('❌ No valid PCA embeddings found');
      return;
    }

    const embeddings = validArticles.map(a => a.embedding_pca);

    // Create embedding matrix in the format faiss-node expects (flat array)
    console.log('🧮 Creating embedding matrix...');
    const matrixData = [];
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = 0; j < REDUCED_DIMENSIONS; j++) {
        matrixData.push(embeddings[i][j]);
      }
    }

    // Create Faiss index (using FlatL2 for simplicity and accuracy)
    console.log('🔍 Creating Faiss index...');
    faissIndex = new faiss.IndexFlatL2(REDUCED_DIMENSIONS);
    
    console.log('📥 Adding embeddings to index...');
    // Add embeddings to index (faiss-node expects flat array)
    faissIndex.add(matrixData);

    // Store article IDs for mapping index results back to articles
    articleIds = validArticles.map(a => a._id.toString());
    
    console.log(`✅ Faiss index initialized successfully with ${embeddings.length} articles`);
    console.log(`📏 Index dimension: ${REDUCED_DIMENSIONS}D (FlatL2)`);
    
  } catch (err) {
    console.error('❌ Error initializing Faiss index:', err);
    faissIndex = null;
    articleIds = [];
  } finally {
    isInitializing = false;
  }
}

/**
 * Search for similar articles using Faiss index
 * @param {number[]} userEmbedding - PCA-reduced user embedding
 * @param {number} k - Number of results to return
 * @returns {Promise<Object>} Search results with distances and article IDs
 */
async function searchFaissIndex(userEmbedding, k = 10) {
  if (!faissIndex) {
    throw new Error('Faiss index not initialized. Call initializeFaissIndex() first.');
  }

  if (!Array.isArray(userEmbedding) || userEmbedding.length !== REDUCED_DIMENSIONS) {
    throw new Error(`Invalid user embedding. Expected ${REDUCED_DIMENSIONS}D array, got ${userEmbedding?.length}D`);
  }

  try {
    // Create query matrix (flat array format)
    const queryData = [...userEmbedding];
    
    // Search the index
    const searchResults = faissIndex.search(queryData, k);
    
    // Map results back to article IDs
    const results = {
      distances: searchResults.distances,
      labels: searchResults.labels.map(idx => articleIds[idx]),
      articleIds: searchResults.labels.map(idx => articleIds[idx])
    };

    return results;
    
  } catch (err) {
    console.error('❌ Error searching Faiss index:', err);
    throw err;
  }
}

/**
 * Get Faiss index status
 */
function getFaissIndexStatus() {
  return {
    initialized: !!faissIndex,
    totalVectors: faissIndex ? faissIndex.ntotal() : 0,
    dimension: REDUCED_DIMENSIONS,
    isInitializing
  };
}

/**
 * Reset the Faiss index (useful for testing or reinitialization)
 */
function resetFaissIndex() {
  faissIndex = null;
  articleIds = [];
  isInitializing = false;
  console.log('🔄 Faiss index reset');
}

module.exports = {
  initializeFaissIndex,
  searchFaissIndex,
  getFaissIndexStatus,
  resetFaissIndex
};
