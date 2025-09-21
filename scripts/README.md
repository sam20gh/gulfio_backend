# Reel Embedding Management Scripts

This directory contains scripts to manage embeddings for video reels in the database.

## Background

The system uses two types of embeddings for reels:
- **embedding**: 1536-dimensional vector from DeepSeek AI API
- **embedding_pca**: 128-dimensional PCA-reduced vector for faster similarity searches

## Scripts Overview

### 1. Check Status (`checkReelEmbeddingStatus.js`)
Provides a comprehensive report on the current embedding status of all reels.

```bash
npm run check-reel-embeddings
```

**What it shows:**
- Total number of reels
- How many have embeddings vs missing embeddings
- How many have PCA embeddings vs missing PCA embeddings
- Sample reels that need work
- Recommended actions

### 2. Fix All Embeddings (`fixReelEmbeddings.js`)
Comprehensive script that handles both missing embeddings and missing PCA embeddings.

```bash
npm run fix-reel-embeddings
```

**What it does:**
- Generates missing embeddings for reels that don't have them
- Generates missing PCA embeddings for reels that have embeddings but no PCA
- Processes in batches with rate limiting
- Provides detailed progress reports

### 3. Update PCA Only (`updateReelPCAEmbeddings.js`)
Focused script that only generates PCA embeddings for reels that already have regular embeddings.

```bash
npm run update-reel-pca
```

**What it does:**
- Finds reels with embeddings but missing PCA embeddings
- Generates PCA embeddings using the existing embeddings
- Faster than the comprehensive fix script

## Usage Workflow

### For New Setups
1. **Check status first:**
   ```bash
   npm run check-reel-embeddings
   ```

2. **Run comprehensive fix:**
   ```bash
   npm run fix-reel-embeddings
   ```

3. **Verify results:**
   ```bash
   npm run check-reel-embeddings
   ```

### For Maintenance
If you only need to add PCA embeddings to recently added reels:
```bash
npm run update-reel-pca
```

## New Reel Upload Process

When uploading new reels via the `/reels/upload` endpoint, the system now automatically:
1. Generates the main embedding (1536D) using DeepSeek API
2. Generates the PCA embedding (128D) using the trained PCA model
3. Saves both embeddings to the database

## Environment Variables

Make sure these are set in your environment:
- `MONGO_URI` (or `MONGODB_URI`): MongoDB connection string
- `OPENAI_API_KEY`: OpenAI API key for generating embeddings (used by the deepseek utility)

## Performance Notes

- **Embedding generation**: Uses DeepSeek API, rate-limited to avoid quota issues
- **PCA generation**: Local computation, much faster
- **Batch processing**: Scripts process in batches to avoid memory issues
- **Progress reporting**: Real-time progress updates during processing

## Error Handling

The scripts include comprehensive error handling:
- Skips invalid reels
- Continues processing even if individual reels fail
- Provides detailed error reporting
- Final verification of results

## MongoDB Indexes

Make sure these indexes exist for optimal performance:
```javascript
db.reels.createIndex({ "embedding": 1 })
db.reels.createIndex({ "embedding_pca": 1 })
db.reels.createIndex({ "scrapedAt": -1 })
```

## Atlas Search Index

For vector search functionality, create this Atlas Search index:
```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "embedding_pca": {
        "type": "vector",
        "similarity": "cosine",
        "dimensions": 128
      }
    }
  }
}
```
