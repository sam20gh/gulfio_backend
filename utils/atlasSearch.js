/**
 * 🔍 MongoDB Atlas Search Utilities
 * Provides optimized full-text search using Atlas Search indexes
 * instead of inefficient $regex queries.
 */

const Article = require('../models/Article');

/**
 * Search articles using Atlas Search aggregation pipeline
 * @param {Object} options - Search options
 * @param {string} options.searchTerm - The search query
 * @param {string} options.language - Language filter (optional)
 * @param {string} options.category - Category filter (optional)
 * @param {Array} options.sourceIds - Source IDs to filter (optional)
 * @param {number} options.limit - Max results (default 50)
 * @param {number} options.skip - Results to skip for pagination (default 0)
 * @returns {Promise<Array>} Search results with relevance scores
 */
async function searchArticles({
    searchTerm,
    language,
    category,
    sourceIds,
    limit = 50,
    skip = 0
}) {
    if (!searchTerm || !searchTerm.trim()) {
        return { articles: [], total: 0 };
    }

    const cleanedSearchTerm = searchTerm.trim();
    console.log(`🔍 Atlas Search: "${cleanedSearchTerm}", lang: ${language || 'all'}, cat: ${category || 'all'}`);

    // Build the Atlas Search compound query
    const must = [];
    const filter = [];

    // Main text search on title and content with boosted title
    must.push({
        compound: {
            should: [
                {
                    text: {
                        query: cleanedSearchTerm,
                        path: 'title',
                        score: { boost: { value: 3 } } // Boost title matches
                    }
                },
                {
                    text: {
                        query: cleanedSearchTerm,
                        path: 'content',
                        score: { boost: { value: 1 } }
                    }
                }
            ],
            minimumShouldMatch: 1
        }
    });

    // Add language filter
    if (language) {
        filter.push({
            text: {
                query: language,
                path: 'language'
            }
        });
    }

    // Add category filter
    if (category) {
        filter.push({
            text: {
                query: category,
                path: 'category'
            }
        });
    }

    // Add source IDs filter
    if (sourceIds && sourceIds.length > 0) {
        filter.push({
            in: {
                path: 'sourceId',
                value: sourceIds
            }
        });
    }

    // Build aggregation pipeline
    const pipeline = [
        {
            $search: {
                index: 'articles_search', // Your Atlas Search index name
                compound: {
                    must,
                    ...(filter.length > 0 && { filter })
                },
                highlight: {
                    path: ['title', 'content']
                },
                count: { type: 'total' }
            }
        },
        {
            $addFields: {
                searchScore: { $meta: 'searchScore' },
                highlights: { $meta: 'searchHighlights' }
            }
        },
        // Get total count before pagination
        {
            $facet: {
                metadata: [{ $count: 'total' }],
                articles: [
                    { $skip: skip },
                    { $limit: limit },
                    {
                        $lookup: {
                            from: 'sources',
                            localField: 'sourceId',
                            foreignField: '_id',
                            as: 'source'
                        }
                    },
                    {
                        $unwind: {
                            path: '$source',
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $project: {
                            _id: 1,
                            title: 1,
                            content: { $substrCP: ['$content', 0, 500] }, // Truncate content
                            url: 1,
                            category: 1,
                            publishedAt: 1,
                            image: 1,
                            viewCount: 1,
                            likes: 1,
                            dislikes: 1,
                            language: 1,
                            searchScore: 1,
                            highlights: 1,
                            sourceName: '$source.name',
                            sourceIcon: '$source.icon',
                            sourceGroupName: '$source.groupName'
                        }
                    }
                ]
            }
        }
    ];

    try {
        const results = await Article.aggregate(pipeline);

        const total = results[0]?.metadata[0]?.total || 0;
        const articles = results[0]?.articles || [];

        console.log(`✅ Atlas Search found ${total} total, returning ${articles.length} articles`);

        return { articles, total };
    } catch (error) {
        // Fallback to regex search if Atlas Search index doesn't exist
        if (error.code === 31082 || error.message.includes('$search')) {
            console.warn('⚠️ Atlas Search index not found, falling back to regex search');
            return fallbackRegexSearch({ searchTerm: cleanedSearchTerm, language, category, sourceIds, limit, skip });
        }
        throw error;
    }
}

/**
 * Autocomplete search for article titles using Atlas Search autocomplete
 * @param {Object} options - Autocomplete options
 * @param {string} options.query - Partial search query
 * @param {string} options.language - Language filter (optional)
 * @param {number} options.limit - Max suggestions (default 10)
 * @returns {Promise<Array>} Autocomplete suggestions
 */
async function autocompleteArticles({ query, language, limit = 10 }) {
    if (!query || query.trim().length < 2) {
        return [];
    }

    const cleanedQuery = query.trim();

    const pipeline = [
        {
            $search: {
                index: 'articles_search',
                autocomplete: {
                    query: cleanedQuery,
                    path: 'title',
                    fuzzy: {
                        maxEdits: 1,
                        prefixLength: 2
                    }
                }
            }
        },
        ...(language ? [{ $match: { language } }] : []),
        { $limit: limit },
        {
            $project: {
                _id: 1,
                title: 1,
                category: 1,
                publishedAt: 1,
                image: { $arrayElemAt: ['$image', 0] }
            }
        }
    ];

    try {
        const results = await Article.aggregate(pipeline);
        console.log(`🔍 Autocomplete for "${cleanedQuery}": ${results.length} suggestions`);
        return results;
    } catch (error) {
        console.warn('⚠️ Autocomplete failed:', error.message);
        return [];
    }
}

/**
 * Fallback regex search when Atlas Search is unavailable
 * Used during development or if the search index isn't configured
 */
async function fallbackRegexSearch({ searchTerm, language, category, sourceIds, limit, skip }) {
    console.log(`⚠️ Fallback regex search for: "${searchTerm}"`);

    const filter = {};

    if (language) filter.language = language;
    if (category) filter.category = category;
    if (sourceIds && sourceIds.length > 0) {
        filter.sourceId = { $in: sourceIds };
    }

    // Case-insensitive regex search (less efficient)
    filter.$or = [
        { title: { $regex: searchTerm, $options: 'i' } },
        { content: { $regex: searchTerm, $options: 'i' } }
    ];

    const [articles, total] = await Promise.all([
        Article.find(filter)
            .populate({
                path: 'sourceId',
                select: 'name icon groupName status',
                match: { status: { $ne: 'blocked' } }
            })
            .sort({ publishedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Article.countDocuments(filter)
    ]);

    return {
        articles: articles.map(a => ({
            ...a,
            sourceName: a.sourceId?.name || 'Unknown Source',
            sourceIcon: a.sourceId?.icon || null,
            sourceGroupName: a.sourceId?.groupName || null,
            searchScore: 1 // No relevance scoring with regex
        })),
        total
    };
}

/**
 * Search for content within articles (for find/replace feature)
 * Uses Atlas Search for better performance on large datasets
 * Supports Unicode characters (Farsi, Arabic, etc.)
 * @param {Object} options - Search options
 * @param {string} options.findText - Text to find
 * @param {string} options.contentFormat - Filter by content format (optional)
 * @param {number} options.limit - Max results (default 1000)
 * @returns {Promise<Array>} Articles containing the text
 */
async function findInContent({ findText, contentFormat, limit = 1000 }) {
    if (!findText || !findText.trim()) {
        return [];
    }

    const cleanedText = findText.trim();

    // Detect if text contains non-Latin characters (Arabic, Farsi, etc.)
    const hasNonLatinChars = /[^\u0000-\u007F]/.test(cleanedText);

    console.log(`🔍 Find in content: "${cleanedText}" (Unicode: ${hasNonLatinChars})`);

    // For non-Latin text (Farsi, Arabic), use regex directly as Atlas Search
    // may not be properly configured for these languages
    if (hasNonLatinChars) {
        console.log('🌐 Using regex search for non-Latin characters');
        return findInContentRegex({ findText: cleanedText, contentFormat, limit });
    }

    const filter = contentFormat ? [{ text: { query: contentFormat, path: 'contentFormat' } }] : [];

    const pipeline = [
        {
            $search: {
                index: 'articles_search',
                compound: {
                    must: [{
                        phrase: {
                            query: cleanedText,
                            path: 'content'
                        }
                    }],
                    ...(filter.length > 0 && { filter })
                }
            }
        },
        { $limit: limit },
        {
            $project: {
                _id: 1,
                title: 1,
                content: 1,
                contentFormat: 1
            }
        }
    ];

    try {
        const results = await Article.aggregate(pipeline);
        console.log(`✅ Found ${results.length} articles containing "${cleanedText}"`);
        return results;
    } catch (error) {
        // Fallback to regex if Atlas Search unavailable
        console.warn('⚠️ Atlas Search unavailable, using regex fallback');
        return findInContentRegex({ findText: cleanedText, contentFormat, limit });
    }
}

/**
 * Regex-based content search with proper Unicode support
 * Used for non-Latin characters (Farsi, Arabic, etc.) and as fallback
 */
async function findInContentRegex({ findText, contentFormat, limit = 1000 }) {
    console.log(`🔍 Regex search for: "${findText}"`);

    // Escape special regex characters but preserve Unicode
    const escapedText = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Build filter - use $regex without 'i' flag for Unicode, exact match is better for RTL languages
    const filter = {
        content: { $regex: escapedText }
    };

    if (contentFormat) {
        filter.contentFormat = contentFormat;
    }

    try {
        const results = await Article.find(filter)
            .select('_id title content contentFormat')
            .limit(limit)
            .lean();

        console.log(`✅ Regex found ${results.length} articles containing "${findText}"`);
        return results;
    } catch (error) {
        console.error('❌ Regex search error:', error.message);
        return [];
    }
}

module.exports = {
    searchArticles,
    autocompleteArticles,
    findInContent,
    findInContentRegex,
    fallbackRegexSearch
};
