/**
 * Source Cache Utility
 * 
 * Caches source data to avoid repeated $lookup operations in aggregation pipelines.
 * Sources rarely change, so we can safely cache them for longer periods.
 * 
 * This optimization addresses the slow $lookup queries identified in MongoDB profiler.
 */

const redis = require('./redis');
const Source = require('../models/Source');

const SOURCE_CACHE_KEY = 'sources_cache_all';
const SOURCE_MAP_KEY = 'sources_cache_map';
const SOURCE_CACHE_TTL = 3600; // 1 hour cache for sources

let inMemorySourceMap = null;
let inMemoryCacheTime = 0;
const IN_MEMORY_TTL = 60000; // 1 minute in-memory cache for ultra-fast lookups

/**
 * Get all sources from cache or DB
 * @returns {Promise<Array>} Array of sources
 */
async function getAllSources() {
    try {
        // Try Redis cache first
        const cached = await redis.get(SOURCE_CACHE_KEY);
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (err) {
        console.warn('⚠️ Redis source cache get error:', err.message);
    }

    // Fetch from DB
    const sources = await Source.find({ status: { $ne: 'blocked' } })
        .select('_id name icon groupName language status')
        .lean();

    // Cache in Redis
    try {
        await redis.set(SOURCE_CACHE_KEY, JSON.stringify(sources), 'EX', SOURCE_CACHE_TTL);
    } catch (err) {
        console.warn('⚠️ Redis source cache set error:', err.message);
    }

    return sources;
}

/**
 * Get source map (id -> source) for fast lookups
 * Uses in-memory cache for ultra-fast repeated lookups
 * @returns {Promise<Map>} Map of sourceId -> source object
 */
async function getSourceMap() {
    const now = Date.now();

    // Check in-memory cache first
    if (inMemorySourceMap && (now - inMemoryCacheTime) < IN_MEMORY_TTL) {
        return inMemorySourceMap;
    }

    const sources = await getAllSources();

    // Build map
    const sourceMap = new Map();
    for (const source of sources) {
        sourceMap.set(source._id.toString(), {
            name: source.name,
            icon: source.icon,
            groupName: source.groupName,
            language: source.language
        });
    }

    // Update in-memory cache
    inMemorySourceMap = sourceMap;
    inMemoryCacheTime = now;

    return sourceMap;
}

/**
 * Enrich articles with source information without $lookup
 * @param {Array} articles - Array of articles with sourceId
 * @returns {Promise<Array>} Articles with sourceName, sourceIcon, sourceGroupName added
 */
async function enrichArticlesWithSources(articles) {
    if (!articles || articles.length === 0) return articles;

    const sourceMap = await getSourceMap();

    return articles.map(article => {
        const sourceIdStr = article.sourceId?.toString();
        const source = sourceIdStr ? sourceMap.get(sourceIdStr) : null;

        return {
            ...article,
            sourceName: source?.name || 'Unknown Source',
            sourceIcon: source?.icon || null,
            sourceGroupName: source?.groupName || null
        };
    });
}

/**
 * Get single source by ID from cache
 * @param {string} sourceId - Source ObjectId as string
 * @returns {Promise<Object|null>} Source object or null
 */
async function getSourceById(sourceId) {
    if (!sourceId) return null;

    const sourceMap = await getSourceMap();
    return sourceMap.get(sourceId.toString()) || null;
}

/**
 * Invalidate source cache (call when sources are updated)
 */
async function invalidateSourceCache() {
    try {
        await redis.del(SOURCE_CACHE_KEY);
        await redis.del(SOURCE_MAP_KEY);
        inMemorySourceMap = null;
        inMemoryCacheTime = 0;
        console.log('🧹 Source cache invalidated');
    } catch (err) {
        console.warn('⚠️ Failed to invalidate source cache:', err.message);
    }
}

/**
 * Pre-warm source cache (call on server startup)
 */
async function warmSourceCache() {
    try {
        console.log('🔥 Warming source cache...');
        await getSourceMap();
        console.log('✅ Source cache warmed');
    } catch (err) {
        console.warn('⚠️ Failed to warm source cache:', err.message);
    }
}

module.exports = {
    getAllSources,
    getSourceMap,
    enrichArticlesWithSources,
    getSourceById,
    invalidateSourceCache,
    warmSourceCache
};
