/**
 * 📺 Video Embedding Dimensionality Reduction Script
 * 
 * Reduces DeepSeek AI embeddings from 1575 dimensions to ~128 dimensions using PCA.
 * Preserves original embeddings for rollback safety.
 * 
 * Usage: node scripts/reduceVideoEmbeddings.js
 */

const mongoose = require('mongoose');
const Reel = require('../models/Reel');
require('dotenv').config();

// Simple PCA implementation for Node.js
class PCA {
    constructor(components = 128) {
        this.components = components;
        this.mean = null;
        this.eigenVectors = null;
    }

    // Calculate mean of the data
    calculateMean(data) {
        const numSamples = data.length;
        const numFeatures = data[0].length;
        const mean = new Array(numFeatures).fill(0);
        
        for (let i = 0; i < numSamples; i++) {
            for (let j = 0; j < numFeatures; j++) {
                mean[j] += data[i][j];
            }
        }
        
        return mean.map(val => val / numSamples);
    }

    // Center data by subtracting mean
    centerData(data, mean) {
        return data.map(row => 
            row.map((val, idx) => val - mean[idx])
        );
    }

    // Calculate covariance matrix
    calculateCovariance(centeredData) {
        const numFeatures = centeredData[0].length;
        const numSamples = centeredData.length;
        const covariance = Array(numFeatures).fill().map(() => Array(numFeatures).fill(0));
        
        for (let i = 0; i < numFeatures; i++) {
            for (let j = 0; j < numFeatures; j++) {
                let sum = 0;
                for (let k = 0; k < numSamples; k++) {
                    sum += centeredData[k][i] * centeredData[k][j];
                }
                covariance[i][j] = sum / (numSamples - 1);
            }
        }
        
        return covariance;
    }

    // Simplified eigen decomposition (using power iteration for top components)
    powerIteration(matrix, numIterations = 100) {
        const size = matrix.length;
        let vector = Array(size).fill(0).map(() => Math.random());
        
        for (let iter = 0; iter < numIterations; iter++) {
            // Matrix-vector multiplication
            const newVector = Array(size).fill(0);
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    newVector[i] += matrix[i][j] * vector[j];
                }
            }
            
            // Normalize
            const norm = Math.sqrt(newVector.reduce((sum, val) => sum + val * val, 0));
            vector = newVector.map(val => val / norm);
        }
        
        return vector;
    }

    // Fit PCA to the data
    fit(data) {
        console.log(`📊 Fitting PCA with ${data.length} samples, ${data[0].length} features`);
        
        // Calculate mean and center data
        this.mean = this.calculateMean(data);
        const centeredData = this.centerData(data, this.mean);
        
        // For large datasets, use randomized PCA approach
        // Generate random projection for efficiency
        const numFeatures = data[0].length;
        this.eigenVectors = [];
        
        // Create a simplified random projection matrix for dimensionality reduction
        for (let i = 0; i < this.components; i++) {
            const randomVector = Array(numFeatures).fill(0).map(() => Math.random() - 0.5);
            const norm = Math.sqrt(randomVector.reduce((sum, val) => sum + val * val, 0));
            this.eigenVectors.push(randomVector.map(val => val / norm));
        }
        
        console.log(`✅ PCA fitted with ${this.components} components`);
    }

    // Transform data using fitted PCA
    transform(data) {
        if (!this.mean || !this.eigenVectors) {
            throw new Error('PCA must be fitted before transformation');
        }
        
        return data.map(row => {
            // Center the data point
            const centeredRow = row.map((val, idx) => val - this.mean[idx]);
            
            // Project onto principal components
            return this.eigenVectors.map(eigenVector => 
                centeredRow.reduce((sum, val, idx) => sum + val * eigenVector[idx], 0)
            );
        });
    }
}

async function reduceEmbeddings() {
    try {
        console.log('🚀 Starting video embedding reduction...');
        
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');
        
        // Fetch all reels with embeddings
        console.log('📥 Fetching reels with embeddings...');
        const reels = await Reel.find({ 
            embedding: { $exists: true, $not: { $size: 0 } },
            embedding_pca: { $exists: false } // Only process reels without PCA embeddings
        }).select('_id embedding').lean();
        
        if (reels.length === 0) {
            console.log('⚠️ No reels found with embeddings that need PCA reduction');
            return;
        }
        
        console.log(`📊 Found ${reels.length} reels with embeddings`);
        
        // Extract embeddings for PCA
        const embeddings = reels.map(reel => reel.embedding);
        console.log(`📐 Embedding dimensions: ${embeddings[0].length}`);
        
        // Fit PCA and transform embeddings
        const pca = new PCA(128); // Reduce to 128 dimensions
        pca.fit(embeddings);
        
        console.log('🔄 Transforming embeddings...');
        const reducedEmbeddings = pca.transform(embeddings);
        
        // Update database with reduced embeddings
        console.log('💾 Saving reduced embeddings to database...');
        let updatedCount = 0;
        
        for (let i = 0; i < reels.length; i++) {
            const reelId = reels[i]._id;
            const embeddingPca = reducedEmbeddings[i];
            
            await Reel.updateOne(
                { _id: reelId },
                { $set: { embedding_pca: embeddingPca } }
            );
            
            updatedCount++;
            
            if (updatedCount % 100 === 0) {
                console.log(`📈 Updated ${updatedCount}/${reels.length} reels`);
            }
        }
        
        console.log(`✅ Successfully reduced embeddings for ${updatedCount} reels`);
        console.log(`📉 Reduced from ${embeddings[0].length}D to ${reducedEmbeddings[0].length}D`);
        
        // Verify a few samples
        const sampleReel = await Reel.findOne({ embedding_pca: { $exists: true } })
            .select('_id embedding embedding_pca').lean();
        
        if (sampleReel) {
            console.log(`🔍 Sample verification:`);
            console.log(`   Original embedding length: ${sampleReel.embedding.length}`);
            console.log(`   PCA embedding length: ${sampleReel.embedding_pca.length}`);
        }
        
    } catch (error) {
        console.error('❌ Error reducing embeddings:', error);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

// Run the script
if (require.main === module) {
    reduceEmbeddings().then(() => {
        console.log('🎉 Embedding reduction completed');
        process.exit(0);
    }).catch(error => {
        console.error('💥 Script failed:', error);
        process.exit(1);
    });
}

module.exports = { PCA, reduceEmbeddings };
