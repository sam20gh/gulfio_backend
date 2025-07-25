/**
 * 📺 Fast Index for Video Recommendations
 * 
 * Provides efficient similarity search for video recommendations.
 * Uses in-memory indexing with cosine similarity for fast lookups.
 * Fallback implementation without external dependencies.
 */

const Reel = require('../models/Reel');
const NodeCache = require('node-cache');

class FastRecommendationIndex {
    constructor() {
        this.index = new Map(); // videoId -> { embedding_pca, metadata }
        this.cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache
        this.isIndexBuilt = false;
        this.lastIndexUpdate = null;
    }

    /**
     * Calculate cosine similarity between two vectors
     */
    cosineSimilarity(vec1, vec2) {
        if (!vec1 || !vec2 || vec1.length !== vec2.length) {
            return 0;
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            normA += vec1[i] * vec1[i];
            normB += vec2[i] * vec2[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        return magnitude === 0 ? 0 : dotProduct / magnitude;
    }

    /**
     * Build or rebuild the search index
     */
    async buildIndex() {
        try {
            console.log('🔨 Building video recommendation index...');

            // Fetch all reels with PCA embeddings
            const reels = await Reel.find({
                embedding_pca: { $exists: true, $not: { $size: 0 } }
            })
                .select('_id reelId videoUrl caption likes dislikes viewCount publishedAt source embedding_pca')
                .populate('source', 'name')
                .lean();

            console.log(`📊 Found ${reels.length} reels with PCA embeddings`);

            // Clear existing index
            this.index.clear();

            // Build new index
            for (const reel of reels) {
                this.index.set(reel._id.toString(), {
                    embedding_pca: reel.embedding_pca,
                    metadata: {
                        _id: reel._id,
                        reelId: reel.reelId,
                        videoUrl: reel.videoUrl,
                        caption: reel.caption,
                        likes: reel.likes || 0,
                        dislikes: reel.dislikes || 0,
                        viewCount: reel.viewCount || 0,
                        publishedAt: reel.publishedAt,
                        source: reel.source,
                        engagementScore: this.calculateEngagementScore(reel)
                    }
                });
            }

            this.isIndexBuilt = true;
            this.lastIndexUpdate = new Date();

            console.log(`✅ Index built with ${this.index.size} videos`);
            return true;

        } catch (error) {
            console.error('❌ Error building recommendation index:', error);
            return false;
        }
    }

    /**
     * Calculate engagement score for a reel
     */
    calculateEngagementScore(reel) {
        const likes = reel.likes || 0;
        const dislikes = reel.dislikes || 0;
        const views = reel.viewCount || 0;

        // Simple engagement formula
        const likeRatio = views > 0 ? likes / views : 0;
        const dislikeRatio = views > 0 ? dislikes / views : 0;
        const recency = this.getRecencyScore(reel.publishedAt);

        return (likes * 2 + views * 0.1 - dislikes * 0.5) * recency * (1 + likeRatio - dislikeRatio);
    }

    /**
     * Calculate recency score (newer content gets higher score)
     */
    getRecencyScore(publishedAt) {
        if (!publishedAt) return 0.5;

        const now = new Date();
        const daysDiff = (now - new Date(publishedAt)) / (1000 * 60 * 60 * 24);

        // Exponential decay over 30 days
        return Math.exp(-daysDiff / 30);
    }

    /**
     * Find similar videos using cosine similarity
     */
    async findSimilar(queryEmbedding, options = {}) {
        const {
            limit = 20,
            excludeIds = [],
            minSimilarity = 0.1
        } = options;

        if (!this.isIndexBuilt) {
            console.log('⚠️ Index not built, building now...');
            await this.buildIndex();
        }

        const similarities = [];

        // Calculate similarity with all indexed videos
        for (const [videoId, data] of this.index.entries()) {
            if (excludeIds.includes(videoId)) continue;

            const similarity = this.cosineSimilarity(queryEmbedding, data.embedding_pca);

            if (similarity >= minSimilarity) {
                similarities.push({
                    similarity,
                    ...data.metadata
                });
            }
        }

        // Sort by similarity and engagement
        similarities.sort((a, b) => {
            // Weighted score: 70% similarity + 30% engagement
            const scoreA = a.similarity * 0.7 + (a.engagementScore / 1000) * 0.3;
            const scoreB = b.similarity * 0.7 + (b.engagementScore / 1000) * 0.3;
            return scoreB - scoreA;
        });

        return similarities.slice(0, limit);
    }

    /**
     * Get trending videos for fallback recommendations
     */
    async getTrendingVideos(options = {}) {
        const {
            limit = 10,
            excludeIds = [],
            maxAge = 7 // days
        } = options;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - maxAge);

        const trending = [];

        for (const [videoId, data] of this.index.entries()) {
            if (excludeIds.includes(videoId)) continue;

            const publishedAt = new Date(data.metadata.publishedAt);
            if (publishedAt < cutoffDate) continue;

            trending.push(data.metadata);
        }

        // Sort by engagement score
        trending.sort((a, b) => b.engagementScore - a.engagementScore);

        return trending.slice(0, limit);
    }

    /**
     * Get diverse video recommendations
     */
    async getDiverseVideos(options = {}) {
        const {
            limit = 5,
            excludeIds = []
        } = options;

        const diverse = [];
        const seenSources = new Set();

        for (const [videoId, data] of this.index.entries()) {
            if (excludeIds.includes(videoId)) continue;
            if (diverse.length >= limit) break;

            const sourceName = data.metadata.source?.name;
            if (sourceName && !seenSources.has(sourceName)) {
                diverse.push(data.metadata);
                seenSources.add(sourceName);
            }
        }

        // Fill remaining slots with random content
        if (diverse.length < limit) {
            const remaining = Array.from(this.index.values())
                .filter(data => !excludeIds.includes(data.metadata._id.toString()))
                .sort(() => Math.random() - 0.5)
                .slice(0, limit - diverse.length);

            diverse.push(...remaining.map(data => data.metadata));
        }

        return diverse;
    }

    /**
     * Get cache key for user recommendations
     */
    getUserCacheKey(userId) {
        return `user_recommendations_${userId}`;
    }

    /**
     * Cache user recommendations
     */
    cacheUserRecommendations(userId, recommendations) {
        const cacheKey = this.getUserCacheKey(userId);
        this.cache.set(cacheKey, recommendations, 21600); // 6 hours
    }

    /**
     * Get cached user recommendations
     */
    getCachedUserRecommendations(userId) {
        const cacheKey = this.getUserCacheKey(userId);
        return this.cache.get(cacheKey);
    }

    /**
     * Clear user cache
     */
    clearUserCache(userId) {
        const cacheKey = this.getUserCacheKey(userId);
        this.cache.del(cacheKey);
    }

    /**
     * Get index stats
     */
    getStats() {
        return {
            indexSize: this.index.size,
            isIndexBuilt: this.isIndexBuilt,
            lastIndexUpdate: this.lastIndexUpdate,
            cacheSize: this.cache.keys().length
        };
    }

    /**
     * Force rebuild index (for manual refresh)
     */
    async forceRebuild() {
        console.log('🔄 Force rebuilding recommendation index...');
        this.isIndexBuilt = false;
        return await this.buildIndex();
    }
}

// Create singleton instance
const recommendationIndex = new FastRecommendationIndex();

module.exports = {
    FastRecommendationIndex,
    recommendationIndex
};
