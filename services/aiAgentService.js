const Article = require('../models/Article');
const axios = require('axios');

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini';
const MAX_ARTICLES = 4;
const VECTOR_INDEX_NAME = 'vec_full';
const VECTOR_CANDIDATES = 150; // Optimized for speed

/**
 * Detect language of the query text
 */
function detectQueryLanguage(query) {
    const farsiSpecificPattern = /[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/;
    const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;

    if (farsiSpecificPattern.test(query)) return 'farsi';
    if (arabicPattern.test(query)) return 'arabic';
    return 'english';
}

/**
 * Generate embedding for user query using OpenAI
 */
async function generateQueryEmbedding(query) {
    const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
            input: query,
            model: EMBEDDING_MODEL,
            dimensions: 1536
        },
        {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 8000 // Tight timeout — embedding should complete in <3s
        }
    );
    return response.data.data[0].embedding;
}

/**
 * Run vector search pipeline with a precomputed embedding
 */
async function runVectorSearch(queryEmbedding, matchConditions, detectedLocation) {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 30);
    const veryRecentDate = new Date();
    veryRecentDate.setDate(veryRecentDate.getDate() - 7);

    const pipeline = [
        {
            $vectorSearch: {
                index: VECTOR_INDEX_NAME,
                path: 'embedding',
                queryVector: queryEmbedding,
                numCandidates: VECTOR_CANDIDATES, // Fixed: was hardcoded 500, now uses constant (150)
                limit: MAX_ARTICLES * 4
            }
        }
    ];

    if (Object.keys(matchConditions).length > 0) {
        pipeline.push({ $match: matchConditions });
    }

    pipeline.push({
        $addFields: {
            relevanceScore: { $meta: 'vectorSearchScore' },
            locationBoost: detectedLocation ? {
                $cond: {
                    if: {
                        $or: [
                            { $regexMatch: { input: '$title', regex: detectedLocation, options: 'i' } },
                            { $regexMatch: { input: { $substr: ['$content', 0, 300] }, regex: detectedLocation, options: 'i' } }
                        ]
                    },
                    then: 1.5,
                    else: 0.7
                }
            } : 1.0,
            recencyBoost: {
                $cond: {
                    if: { $gte: ['$publishedAt', veryRecentDate] },
                    then: 1.15,
                    else: {
                        $cond: {
                            if: { $gte: ['$publishedAt', recentDate] },
                            then: 1.05,
                            else: 1.0
                        }
                    }
                }
            },
            viewBoost: {
                $cond: {
                    if: { $gte: ['$viewCount', 100] },
                    then: 1.05,
                    else: 1.0
                }
            }
        }
    });

    pipeline.push({
        $addFields: {
            finalScore: { $multiply: ['$relevanceScore', '$locationBoost', '$recencyBoost', '$viewBoost'] }
        }
    });

    pipeline.push({ $sort: { finalScore: -1 } });
    pipeline.push({ $limit: MAX_ARTICLES });
    pipeline.push({
        $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'sourceInfo'
        }
    });
    pipeline.push({
        $project: {
            _id: 1, title: 1, content: 1, url: 1, category: 1,
            publishedAt: 1, image: 1, viewCount: 1,
            sourceGroupName: {
                $ifNull: ['$sourceGroupName', { $arrayElemAt: ['$sourceInfo.groupName', 0] }]
            },
            relevanceScore: 1, finalScore: 1
        }
    });

    return Article.aggregate(pipeline);
}

/**
 * Search articles using Atlas Vector Search.
 * Accepts an optional precomputed embedding to avoid redundant API calls.
 */
async function searchArticles(query, category = null, _userId = null, _usePersonalization = true, language = null, precomputedEmbedding = null) {
    try {
        const detectedLanguage = language || detectQueryLanguage(query);

        const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah',
            'Fujairah', 'Umm Al Quwain', 'Saudi', 'Arabia', 'Qatar', 'Doha',
            'Kuwait', 'Bahrain', 'Oman', 'Muscat', 'Egypt', 'Cairo', 'Jordan', 'Amman'];

        const queryLower = query.toLowerCase();
        const detectedLocation = locationKeywords.find(loc => queryLower.includes(loc.toLowerCase()));

        // Use precomputed embedding if available, otherwise generate
        const queryEmbedding = precomputedEmbedding || await generateQueryEmbedding(query);

        // Build match conditions with language filter
        const matchConditions = {};
        if (category && category !== 'all') matchConditions.category = category;
        matchConditions.language = detectedLanguage;

        let articles = await runVectorSearch(queryEmbedding, matchConditions, detectedLocation);

        // If language-filtered search returns nothing, retry without language filter
        if (articles.length === 0) {
            console.log(`⚠️ No results for language '${detectedLanguage}', retrying without language filter`);
            const broadConditions = {};
            if (category && category !== 'all') broadConditions.category = category;
            articles = await runVectorSearch(queryEmbedding, broadConditions, detectedLocation);
        }

        const hasGoodResults = articles.some(a => a.relevanceScore && a.relevanceScore > 0.5);

        if (articles.length === 0 || !hasGoodResults) {
            console.log('⚠️ Vector search scores too low, falling back to text search');
            return fallbackTextSearch(query, category, detectedLocation, detectedLanguage);
        }

        return articles;
    } catch (error) {
        console.error('❌ Error in searchArticles:', error.message);
        const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi', 'Arabia', 'Qatar', 'Egypt'];
        const detectedLang = language || detectQueryLanguage(query);
        const detectedLocation = locationKeywords.find(loc => query.toLowerCase().includes(loc.toLowerCase()));
        return fallbackTextSearch(query, category, detectedLocation, detectedLang);
    }
}

/**
 * Fallback text search if vector search fails
 */
async function fallbackTextSearch(query, category = null, detectedLocation = null, language = 'english') {
    try {
        if (!detectedLocation) {
            const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi', 'Arabia', 'Qatar', 'Doha',
                'Kuwait', 'Bahrain', 'Oman', 'Egypt', 'Cairo', 'Jordan'];
            const queryLower = query.toLowerCase();
            detectedLocation = locationKeywords.find(loc => queryLower.includes(loc.toLowerCase()));
        }

        const keywords = query.toLowerCase().split(' ').filter(word => word.length > 2);
        const keywordRegex = keywords.join('|');

        const matchConditions = {
            $or: [
                { title: { $regex: keywordRegex, $options: 'i' } },
                { content: { $regex: keywordRegex, $options: 'i' } }
            ],
            language
        };

        if (category && category !== 'all') matchConditions.category = category;

        if (detectedLocation) {
            matchConditions.$or.push(
                { title: { $regex: detectedLocation, $options: 'i' } },
                { content: { $regex: detectedLocation, $options: 'i' } }
            );
        }

        let articles = await Article.find(matchConditions)
            .sort({ viewCount: -1, publishedAt: -1 })
            .limit(MAX_ARTICLES * 10)
            .select('_id title content url category publishedAt image viewCount sourceGroupName sourceId')
            .populate('sourceId', 'groupName name')
            .lean();

        if (detectedLocation && articles.length > 0) {
            const locationMatches = articles.filter(a =>
                (a.title && a.title.toLowerCase().includes(detectedLocation.toLowerCase())) ||
                (a.content && a.content.toLowerCase().includes(detectedLocation.toLowerCase()))
            );
            const nonLocationMatches = articles.filter(a =>
                !((a.title && a.title.toLowerCase().includes(detectedLocation.toLowerCase())) ||
                    (a.content && a.content.toLowerCase().includes(detectedLocation.toLowerCase())))
            );
            articles = [...locationMatches, ...nonLocationMatches].slice(0, MAX_ARTICLES);
        } else {
            articles = articles.slice(0, MAX_ARTICLES);
        }

        articles = articles.map(article => ({
            ...article,
            sourceGroupName: article.sourceGroupName || article.sourceId?.groupName || article.sourceId?.name || 'Gulf.io'
        }));

        if (articles.length === 0) {
            const recentConditions = { language };
            if (category && category !== 'all') recentConditions.category = category;

            let recentArticles = await Article.find(recentConditions)
                .sort({ publishedAt: -1 })
                .limit(MAX_ARTICLES)
                .select('_id title content url category publishedAt image viewCount sourceGroupName sourceId')
                .populate('sourceId', 'groupName name')
                .lean();

            recentArticles = recentArticles.map(article => ({
                ...article,
                sourceGroupName: article.sourceGroupName || article.sourceId?.groupName || article.sourceId?.name || 'Gulf.io'
            }));

            return recentArticles;
        }

        return articles;
    } catch (error) {
        console.error('❌ Fallback search failed:', error.message);
        return [];
    }
}

/**
 * Generate AI response using GPT-4o-mini with retrieved articles
 */
async function generateResponse(query, articles) {
    const startTime = Date.now();

    try {
        const queryLanguage = detectQueryLanguage(query);

        const context = articles.map((article, idx) => {
            const publishDate = new Date(article.publishedAt).toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric'
            });
            const preview = article.content
                ? article.content.replace(/<[^>]*>/g, '').substring(0, 300)
                : 'Content not available';

            return `[${idx + 1}] ${article.title}\nCategory: ${article.category}\nPublished: ${publishDate}\nSource: ${article.sourceGroupName || 'Gulf.io'}\nSummary: ${preview}`;
        }).join('\n\n---\n\n');

        const languageInstructions = {
            arabic: 'IMPORTANT: Respond in Arabic (العربية) only.',
            farsi: 'IMPORTANT: Respond in Farsi (فارسی) only.',
            english: 'Respond in English.'
        };

        const systemPrompt = `You are Gulf.io's AI assistant, an expert on Middle East news. ${languageInstructions[queryLanguage]}

Answer based ONLY on the provided articles. Cite sources using [1], [2], etc. Be informative and concise. If no relevant articles exist, say so honestly.

Articles (${articles.length} found):
${context}`;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: CHAT_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: query }
                ],
                temperature: 0.7,
                max_tokens: 800,
                presence_penalty: 0.1,
                frequency_penalty: 0.1
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000 // 25s — gpt-4o-mini should respond well within this
            }
        );

        const aiText = response.data.choices[0].message.content;
        const responseTime = Date.now() - startTime;

        const articleReferences = articles.map((article, idx) => ({
            _id: article._id,
            title: article.title,
            url: article.url,
            category: article.category,
            publishedAt: article.publishedAt,
            image: article.image,
            sourceGroupName: article.sourceGroupName || 'Gulf.io',
            referenceNumber: idx + 1
        }));

        return {
            text: aiText,
            articles: articleReferences,
            metadata: {
                articlesFound: articles.length,
                articlesReturned: articleReferences.length,
                searchQuery: query,
                responseTime
            }
        };
    } catch (error) {
        console.error('❌ Error generating AI response:', error.response?.data || error.message);

        const fallbackResponse = articles.length > 0
            ? `I found ${articles.length} relevant article(s) about "${query}":\n\n` +
              articles.slice(0, 3).map((a, i) =>
                  `[${i + 1}] ${a.title} (${new Date(a.publishedAt).toLocaleDateString()})`
              ).join('\n') +
              '\n\nPlease try again for a detailed summary.'
            : `I couldn't find relevant articles about "${query}". Try asking about recent Gulf region news, business, sports, or politics.`;

        return {
            text: fallbackResponse,
            articles: articles.slice(0, 3),
            metadata: {
                articlesFound: articles.length,
                searchQuery: query,
                responseTime: Date.now() - startTime,
                fallback: true
            }
        };
    }
}

/**
 * Get suggested questions based on recent articles
 */
async function getSuggestedQuestions() {
    try {
        const recentArticles = await Article.aggregate([
            {
                $match: {
                    language: 'english',
                    publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
                }
            },
            { $group: { _id: '$category', topArticle: { $first: '$$ROOT' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 4 },
            { $project: { category: '$_id', title: '$topArticle.title', count: 1 } }
        ]);

        const suggestions = [
            "What's happening in the UAE today?",
            'Latest business news from Saudi Arabia',
            'Gulf sports updates this week',
            "What's new in Qatar?",
        ];

        recentArticles.forEach(article => {
            if (article.category === 'business') suggestions.push('Latest Gulf business developments');
            else if (article.category === 'sports') suggestions.push('Recent sports news from the region');
            else if (article.category === 'politics') suggestions.push('Recent political developments in the Middle East');
        });

        return suggestions.slice(0, 6);
    } catch (error) {
        console.error('❌ Error getting suggestions:', error.message);
        return [
            "What's happening in the UAE today?",
            'Latest business news from Saudi Arabia',
            'Gulf sports updates',
            "What's new in Qatar?",
        ];
    }
}

module.exports = {
    searchArticles,
    generateResponse,
    generateQueryEmbedding,
    getSuggestedQuestions,
    detectQueryLanguage
};
