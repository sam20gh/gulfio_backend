const Article = require('../models/Article');
const {
    embedQuery,
    chatCompletion,
    streamChatCompletion,
} = require('./openaiClient');

const CHAT_MODEL = 'gpt-4o-mini';
const MAX_ARTICLES = 4;
const VECTOR_INDEX_NAME = 'vec_full';
const VECTOR_CANDIDATES = 150;
const MAX_TOKENS = 450;
const ARTICLE_PREVIEW_CHARS = 180;
const GOOD_SCORE_THRESHOLD = 0.35;

const LOCATION_KEYWORDS = [
    'UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah',
    'Fujairah', 'Umm Al Quwain', 'Saudi', 'Arabia', 'Qatar', 'Doha',
    'Kuwait', 'Bahrain', 'Oman', 'Muscat', 'Egypt', 'Cairo', 'Jordan', 'Amman',
];

function detectQueryLanguage(query) {
    const farsiSpecificPattern = /[پچژگکی]/;
    const arabicPattern = /[؀-ۿݐ-ݿ]/;
    if (farsiSpecificPattern.test(query)) return 'farsi';
    if (arabicPattern.test(query)) return 'arabic';
    return 'english';
}

function detectLocation(query) {
    const lower = query.toLowerCase();
    return LOCATION_KEYWORDS.find(loc => lower.includes(loc.toLowerCase())) || null;
}

// Legacy export name kept for backward compatibility
const generateQueryEmbedding = embedQuery;

async function runVectorSearch(queryEmbedding, matchConditions, detectedLocation) {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 30);
    const veryRecentDate = new Date();
    veryRecentDate.setDate(veryRecentDate.getDate() - 7);

    const pipeline = [{
        $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: queryEmbedding,
            numCandidates: VECTOR_CANDIDATES,
            limit: MAX_ARTICLES * 4,
        },
    }];

    if (Object.keys(matchConditions).length > 0) {
        pipeline.push({ $match: matchConditions });
    }

    // Title-only location regex (dropped expensive substring scan on $content)
    pipeline.push({
        $addFields: {
            relevanceScore: { $meta: 'vectorSearchScore' },
            locationBoost: detectedLocation
                ? {
                    $cond: {
                        if: { $regexMatch: { input: '$title', regex: detectedLocation, options: 'i' } },
                        then: 1.4,
                        else: 0.85,
                    },
                }
                : 1.0,
            recencyBoost: {
                $cond: {
                    if: { $gte: ['$publishedAt', veryRecentDate] },
                    then: 1.15,
                    else: {
                        $cond: { if: { $gte: ['$publishedAt', recentDate] }, then: 1.05, else: 1.0 },
                    },
                },
            },
            viewBoost: {
                $cond: { if: { $gte: ['$viewCount', 100] }, then: 1.05, else: 1.0 },
            },
        },
    });

    pipeline.push({
        $addFields: {
            finalScore: { $multiply: ['$relevanceScore', '$locationBoost', '$recencyBoost', '$viewBoost'] },
        },
    });
    pipeline.push({ $sort: { finalScore: -1 } });
    pipeline.push({ $limit: MAX_ARTICLES });
    pipeline.push({
        $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'sourceInfo',
        },
    });
    pipeline.push({
        $project: {
            _id: 1, title: 1, content: 1, url: 1, category: 1,
            publishedAt: 1, image: 1, viewCount: 1,
            sourceGroupName: {
                $ifNull: ['$sourceGroupName', { $arrayElemAt: ['$sourceInfo.groupName', 0] }],
            },
            relevanceScore: 1, finalScore: 1,
        },
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
        const detectedLocation = detectLocation(query);
        const queryEmbedding = precomputedEmbedding || await embedQuery(query);

        const matchConditions = {};
        if (category && category !== 'all') matchConditions.category = category;
        matchConditions.language = detectedLanguage;

        let articles = await runVectorSearch(queryEmbedding, matchConditions, detectedLocation);

        // If language filter eliminated everything, drop ONLY the language filter
        // and rerun once (instead of doing a full re-search with original conditions).
        if (articles.length === 0) {
            const broadConditions = {};
            if (category && category !== 'all') broadConditions.category = category;
            articles = await runVectorSearch(queryEmbedding, broadConditions, detectedLocation);
        }

        const hasGoodResults = articles.some(a => a.relevanceScore && a.relevanceScore > GOOD_SCORE_THRESHOLD);

        if (articles.length === 0 || !hasGoodResults) {
            return fallbackTextSearch(query, category, detectedLocation, detectedLanguage);
        }

        return articles;
    } catch (error) {
        console.error('❌ Error in searchArticles:', error.message);
        return fallbackTextSearch(query, category, detectLocation(query), language || detectQueryLanguage(query));
    }
}

async function fallbackTextSearch(query, category = null, detectedLocation = null, language = 'english') {
    try {
        if (!detectedLocation) detectedLocation = detectLocation(query);

        const keywords = query.toLowerCase().split(' ').filter(w => w.length > 2);
        const keywordRegex = keywords.join('|');

        const matchConditions = {
            $or: [
                { title: { $regex: keywordRegex, $options: 'i' } },
                { content: { $regex: keywordRegex, $options: 'i' } },
            ],
            language,
        };
        if (category && category !== 'all') matchConditions.category = category;
        if (detectedLocation) {
            matchConditions.$or.push(
                { title: { $regex: detectedLocation, $options: 'i' } },
                { content: { $regex: detectedLocation, $options: 'i' } },
            );
        }

        let articles = await Article.find(matchConditions)
            .sort({ viewCount: -1, publishedAt: -1 })
            .limit(MAX_ARTICLES * 10)
            .select('_id title content url category publishedAt image viewCount sourceGroupName sourceId')
            .populate('sourceId', 'groupName name')
            .lean();

        if (detectedLocation && articles.length > 0) {
            const locLower = detectedLocation.toLowerCase();
            const hits = articles.filter(a =>
                (a.title && a.title.toLowerCase().includes(locLower)) ||
                (a.content && a.content.toLowerCase().includes(locLower)));
            const misses = articles.filter(a => !hits.includes(a));
            articles = [...hits, ...misses].slice(0, MAX_ARTICLES);
        } else {
            articles = articles.slice(0, MAX_ARTICLES);
        }

        articles = articles.map(article => ({
            ...article,
            sourceGroupName: article.sourceGroupName || article.sourceId?.groupName || article.sourceId?.name || 'Gulf.io',
        }));

        if (articles.length === 0) {
            const recentConditions = { language };
            if (category && category !== 'all') recentConditions.category = category;
            const recentArticles = await Article.find(recentConditions)
                .sort({ publishedAt: -1 })
                .limit(MAX_ARTICLES)
                .select('_id title content url category publishedAt image viewCount sourceGroupName sourceId')
                .populate('sourceId', 'groupName name')
                .lean();
            return recentArticles.map(a => ({
                ...a,
                sourceGroupName: a.sourceGroupName || a.sourceId?.groupName || a.sourceId?.name || 'Gulf.io',
            }));
        }

        return articles;
    } catch (error) {
        console.error('❌ Fallback search failed:', error.message);
        return [];
    }
}

function buildArticleReferences(articles) {
    return articles.map((article, idx) => ({
        _id: article._id,
        title: article.title,
        url: article.url,
        category: article.category,
        publishedAt: article.publishedAt,
        image: article.image,
        sourceGroupName: article.sourceGroupName || 'Gulf.io',
        referenceNumber: idx + 1,
    }));
}

function buildChatPayload(query, articles) {
    const queryLanguage = detectQueryLanguage(query);

    const context = articles.map((article, idx) => {
        const publishDate = new Date(article.publishedAt).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
        });
        const preview = article.content
            ? article.content.replace(/<[^>]*>/g, '').substring(0, ARTICLE_PREVIEW_CHARS)
            : 'Content not available';
        return `[${idx + 1}] ${article.title}\nCat: ${article.category} | ${publishDate} | ${article.sourceGroupName || 'Gulf.io'}\n${preview}`;
    }).join('\n\n');

    const langDirective = {
        arabic: 'Respond in Arabic (العربية) only.',
        farsi: 'Respond in Farsi (فارسی) only.',
        english: 'Respond in English.',
    }[queryLanguage];

    const todayStr = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const systemPrompt = `You are Gulf.io's AI news assistant. ${langDirective}
Today: ${todayStr}. Never claim a different date as today.
Answer ONLY from the articles below. Cite sources inline as [1], [2]. Be concise and informative. If nothing relevant, say so.

Articles (${articles.length}):
${context}`;

    return {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
        ],
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
    };
}

async function generateResponse(query, articles) {
    const startTime = Date.now();
    try {
        const payload = buildChatPayload(query, articles);
        const aiText = await chatCompletion(payload);
        const responseTime = Date.now() - startTime;

        return {
            text: aiText,
            articles: buildArticleReferences(articles),
            metadata: {
                articlesFound: articles.length,
                articlesReturned: articles.length,
                searchQuery: query,
                responseTime,
            },
        };
    } catch (error) {
        console.error('❌ Error generating AI response:', error.response?.data || error.message);
        const fallbackResponse = articles.length > 0
            ? `I found ${articles.length} relevant article(s) about "${query}":\n\n` +
              articles.slice(0, 3).map((a, i) =>
                  `[${i + 1}] ${a.title} (${new Date(a.publishedAt).toLocaleDateString()})`,
              ).join('\n') + '\n\nPlease try again for a detailed summary.'
            : `I couldn't find relevant articles about "${query}". Try asking about recent Gulf region news, business, sports, or politics.`;

        return {
            text: fallbackResponse,
            articles: buildArticleReferences(articles.slice(0, 3)),
            metadata: {
                articlesFound: articles.length,
                searchQuery: query,
                responseTime: Date.now() - startTime,
                fallback: true,
            },
        };
    }
}

/**
 * Stream a chat completion. Caller supplies onDelta(textChunk).
 * Resolves with { text, articles, metadata } once the stream is complete.
 */
async function streamResponse(query, articles, { onDelta, signal } = {}) {
    const startTime = Date.now();
    const payload = buildChatPayload(query, articles);
    const text = await streamChatCompletion({ ...payload, onDelta, signal });
    return {
        text,
        articles: buildArticleReferences(articles),
        metadata: {
            articlesFound: articles.length,
            articlesReturned: articles.length,
            searchQuery: query,
            responseTime: Date.now() - startTime,
        },
    };
}

async function getSuggestedQuestions() {
    try {
        const recentArticles = await Article.aggregate([
            {
                $match: {
                    language: 'english',
                    publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
                },
            },
            { $group: { _id: '$category', topArticle: { $first: '$$ROOT' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 4 },
            { $project: { category: '$_id', title: '$topArticle.title', count: 1 } },
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
    streamResponse,
    generateQueryEmbedding,
    getSuggestedQuestions,
    detectQueryLanguage,
    buildArticleReferences,
};
