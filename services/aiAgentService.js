const Article = require('../models/Article');
const axios = require('axios');

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini'; // Using gpt-4o-mini as requested
const MAX_ARTICLES = 4; // Mobile optimized for speed
const VECTOR_INDEX_NAME = 'vec_full'; // New vector search index with full embeddings
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const VECTOR_CANDIDATES = 150; // Mobile optimized
const VECTOR_LIMIT = 10; // Mobile optimized
const BM25_LIMIT = 8; // Mobile optimized
const RERANK_CANDIDATES = 8; // Mobile optimized

/**
 * Generate embedding for user query using OpenAI
 */
async function generateQueryEmbedding(query) {
    try {
        console.log('🧠 Generating embedding for query:', query.substring(0, 100));

        const response = await axios.post(
            'https://api.openai.com/v1/embeddings',
            {
                input: query,
                model: EMBEDDING_MODEL,
                dimensions: 1536 // CRITICAL: Match vec_full index (1536 dimensions, NOT 128!)
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        console.log('✅ Embedding generated successfully');
        return response.data.data[0].embedding;
    } catch (error) {
        console.error('❌ Error generating embedding:', error.response?.data || error.message);
        throw new Error('Failed to generate query embedding');
    }
}

/**
 * Search articles using Atlas Vector Search with embedding_pca field
 */
async function searchArticles(query, category = null, userId = null, usePersonalization = true) {
    try {
        console.log('🔍 Searching articles for query:', query);
        console.log('🔍 Search parameters:', { category, userId, usePersonalization });

        // Extract location keywords from query for better filtering
        const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah',
            'Fujairah', 'Umm Al Quwain', 'Saudi', 'Arabia', 'Qatar', 'Doha',
            'Kuwait', 'Bahrain', 'Oman', 'Muscat', 'Egypt', 'Cairo', 'Jordan', 'Amman'];

        const queryLower = query.toLowerCase();
        const detectedLocation = locationKeywords.find(loc =>
            queryLower.includes(loc.toLowerCase())
        );

        console.log('🌍 Detected location in query:', detectedLocation || 'None');

        // Generate embedding for the query
        const queryEmbedding = await generateQueryEmbedding(query);

        // Build aggregation pipeline for Atlas Vector Search
        const pipeline = [
            {
                $vectorSearch: {
                    index: VECTOR_INDEX_NAME, // vec_full index
                    path: 'embedding', // CRITICAL: Use 'embedding' field (1536 dims), NOT embedding_pca!
                    queryVector: queryEmbedding,
                    numCandidates: 500, // Search DEEP into article database for best semantic match
                    limit: MAX_ARTICLES * 4 // Get more candidates for better filtering
                }
            }
        ];

        // Add filters
        const matchConditions = {};

        // Category filter
        if (category && category !== 'all') {
            matchConditions.category = category;
        }

        // Language filter (assuming English articles)
        matchConditions.language = 'english';

        // Location filtering - if location detected, prioritize those articles
        if (detectedLocation) {
            console.log(`🎯 Adding location filter for: ${detectedLocation}`);
            // Don't exclude others, just boost matching ones later
        }

        // NO TIME RESTRICTION - Search all articles for best semantic match
        // Recency boost for articles from last 30 days (mild preference, not requirement)
        const recentDate = new Date();
        recentDate.setDate(recentDate.getDate() - 30);

        // Very recent articles (last 7 days) get extra boost
        const veryRecentDate = new Date();
        veryRecentDate.setDate(veryRecentDate.getDate() - 7);

        if (Object.keys(matchConditions).length > 0) {
            pipeline.push({
                $match: matchConditions
            });
        }

        // Add relevance scoring with semantic match priority
        pipeline.push({
            $addFields: {
                relevanceScore: { $meta: 'vectorSearchScore' },
                // Location boost - STRONG boost if location matches query
                locationBoost: detectedLocation ? {
                    $cond: {
                        if: {
                            $or: [
                                { $regexMatch: { input: '$title', regex: detectedLocation, options: 'i' } },
                                { $regexMatch: { input: { $substr: ['$content', 0, 500] }, regex: detectedLocation, options: 'i' } }
                            ]
                        },
                        then: 1.5, // STRONG boost for location match
                        else: 0.7 // Reduce score for non-matching locations
                    }
                } : 1.0,
                // Mild recency boost - semantic relevance is MORE important
                recencyBoost: {
                    $cond: {
                        if: { $gte: ['$publishedAt', veryRecentDate] },
                        then: 1.15, // Small boost for very recent
                        else: {
                            $cond: {
                                if: { $gte: ['$publishedAt', recentDate] },
                                then: 1.05, // Tiny boost for recent
                                else: 1.0 // Older articles still fully valid
                            }
                        }
                    }
                },
                viewBoost: {
                    $cond: {
                        if: { $gte: ['$viewCount', 100] },
                        then: 1.05, // Reduced view boost to prioritize relevance
                        else: 1.0
                    }
                }
            }
        });

        // Calculate final score with location boost
        pipeline.push({
            $addFields: {
                finalScore: {
                    $multiply: ['$relevanceScore', '$locationBoost', '$recencyBoost', '$viewBoost']
                }
            }
        });

        // Sort by final score
        pipeline.push({
            $sort: { finalScore: -1 }
        });

        // Limit final results
        pipeline.push({
            $limit: MAX_ARTICLES
        });

        // Project only needed fields
        pipeline.push({
            $project: {
                _id: 1,
                title: 1,
                content: 1,
                url: 1,
                category: 1,
                publishedAt: 1,
                image: 1,
                viewCount: 1,
                sourceGroupName: 1,
                relevanceScore: 1,
                finalScore: 1
            }
        });

        console.log('🔍 Running vector search pipeline...');
        const articles = await Article.aggregate(pipeline);

        console.log(`✅ Vector search found ${articles.length} articles`);

        // Check if results are actually relevant (have reasonable scores)
        const hasGoodResults = articles.some(a => a.relevanceScore && a.relevanceScore > 0.5);

        if (articles.length === 0 || !hasGoodResults) {
            if (articles.length === 0) {
                console.log('⚠️ Vector search returned NO results, falling back to text search...');
            } else {
                console.log(`⚠️ Vector search returned ${articles.length} articles but scores too low (best: ${articles[0]?.relevanceScore}), falling back...`);
            }
            return await fallbackTextSearch(query, category, detectedLocation);
        }

        console.log('📊 Articles found:', articles.map(a => ({
            title: a.title.substring(0, 60) + '...',
            category: a.category,
            score: a.finalScore?.toFixed(4)
        })));

        return articles;
    } catch (error) {
        console.error('❌ Error searching articles:', error);
        console.error('❌ Error details:', error.message);
        // Fallback to simple text search if vector search fails
        console.log('🔄 Falling back to text search due to error...');

        // Extract location again for fallback
        const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi', 'Arabia', 'Qatar', 'Egypt'];
        const queryLower = query.toLowerCase();
        const detectedLocation = locationKeywords.find(loc => queryLower.includes(loc.toLowerCase()));

        return await fallbackTextSearch(query, category, detectedLocation);
    }
}

/**
 * Fallback text search if vector search fails - LOCATION AWARE
 */
async function fallbackTextSearch(query, category = null, detectedLocation = null) {
    try {
        console.log('🔄 Fallback text search for query:', query);

        // If location not provided, try to detect it
        if (!detectedLocation) {
            const locationKeywords = ['UAE', 'Dubai', 'Abu Dhabi', 'Sharjah', 'Saudi', 'Arabia', 'Qatar', 'Doha',
                'Kuwait', 'Bahrain', 'Oman', 'Egypt', 'Cairo', 'Jordan'];

            const queryLower = query.toLowerCase();
            detectedLocation = locationKeywords.find(loc =>
                queryLower.includes(loc.toLowerCase())
            );
        }

        console.log('🌍 Fallback detected location:', detectedLocation || 'None');

        // Split query into keywords for better matching
        const keywords = query.toLowerCase().split(' ').filter(word => word.length > 2);
        const keywordRegex = keywords.join('|');

        const matchConditions = {
            $or: [
                { title: { $regex: keywordRegex, $options: 'i' } },
                { content: { $regex: keywordRegex, $options: 'i' } }
            ],
            language: 'english'
        };

        if (category && category !== 'all') {
            matchConditions.category = category;
        }

        // If location detected, prioritize articles with that location
        if (detectedLocation) {
            console.log(`🎯 Fallback: Prioritizing ${detectedLocation} articles`);
            matchConditions.$or.push(
                { title: { $regex: detectedLocation, $options: 'i' } },
                { content: { $regex: detectedLocation, $options: 'i' } }
            );
        }

        // CRITICAL: Search MORE articles and sort by relevance, NOT just recency
        let articles = await Article.find(matchConditions)
            .sort({ viewCount: -1, publishedAt: -1 }) // Prioritize popular over newest
            .limit(MAX_ARTICLES * 10) // Get WAY more candidates
            .select('_id title content url category publishedAt image viewCount sourceGroupName')
            .lean();

        console.log(`✅ Fallback search found ${articles.length} articles for keywords: ${keywords.join(', ')}`);

        // Filter and prioritize by location if detected
        if (detectedLocation && articles.length > 0) {
            // Split into location matches and others
            const locationMatches = articles.filter(a =>
                (a.title && a.title.toLowerCase().includes(detectedLocation.toLowerCase())) ||
                (a.content && a.content.toLowerCase().includes(detectedLocation.toLowerCase()))
            );

            const nonLocationMatches = articles.filter(a =>
                !((a.title && a.title.toLowerCase().includes(detectedLocation.toLowerCase())) ||
                    (a.content && a.content.toLowerCase().includes(detectedLocation.toLowerCase())))
            );

            console.log(`🎯 Location filtering: ${locationMatches.length} ${detectedLocation} articles, ${nonLocationMatches.length} others`);

            // Prioritize location matches
            articles = [...locationMatches, ...nonLocationMatches].slice(0, MAX_ARTICLES);
        } else {
            articles = articles.slice(0, MAX_ARTICLES);
        }

        // If still no results, get recent articles from relevant category
        if (articles.length === 0) {
            console.log('🔄 No keyword matches, getting recent articles...');
            const recentConditions = { language: 'english' };
            if (category && category !== 'all') {
                recentConditions.category = category;
            }

            const recentArticles = await Article.find(recentConditions)
                .sort({ publishedAt: -1 })
                .limit(MAX_ARTICLES)
                .select('_id title content url category publishedAt image viewCount sourceGroupName')
                .lean();

            console.log(`✅ Found ${recentArticles.length} recent articles as final fallback`);
            return recentArticles;
        }

        return articles;
    } catch (error) {
        console.error('❌ Fallback search failed:', error);
        return [];
    }
}

/**
 * Generate AI response using GPT-4o-mini with retrieved articles
 */
async function generateResponse(query, articles, sessionId, userId) {
    try {
        console.log('🤖 Generating AI response for query:', query);
        const startTime = Date.now();

        // Build context from articles
        const context = articles.map((article, idx) => {
            const publishDate = new Date(article.publishedAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });

            const preview = article.content ?
                article.content.replace(/<[^>]*>/g, '').substring(0, 400) :
                'Content not available';

            return `[${idx + 1}] ${article.title}
Category: ${article.category}
Published: ${publishDate}
Source: ${article.sourceGroupName || 'Gulf.io'}
Summary: ${preview}...
URL: ${article.url}`;
        }).join('\n\n---\n\n');

        // Create system prompt
        const systemPrompt = `You are Gulf.io's AI assistant, an expert on Middle East news and current events. You have access to a database of over 23,000 recent articles from trusted Gulf region sources.

Your role:
- Answer questions based ONLY on the provided articles
- Be informative, accurate, and provide balanced perspectives
- Cite article numbers [1], [2], etc. when referencing information
- If the articles don't contain relevant information, acknowledge this honestly
- Provide context about when events occurred and which sources reported them
- Use a professional yet conversational tone
- Focus on facts from the articles, avoid speculation

Available articles (${articles.length} found):
${context}

Guidelines:
- Always cite your sources using [1], [2], etc.
- If multiple articles cover the same topic, synthesize the information
- Mention publication dates when relevant for context
- If no relevant articles are found, suggest related topics the user might ask about`;

        // Build user message with query context
        const userMessage = `User question: "${query}"

Please provide a comprehensive answer based on the available articles. If the articles don't directly answer the question, let me know what related information is available.`;

        console.log('🤖 Calling GPT-4o-mini...');

        // Call OpenAI API
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: CHAT_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userMessage
                    }
                ],
                temperature: 0.7,
                max_tokens: 1000,
                presence_penalty: 0.1,
                frequency_penalty: 0.1
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const aiText = response.data.choices[0].message.content;
        const responseTime = Date.now() - startTime;

        console.log('✅ AI response generated successfully');
        console.log(`⏱️ Response time: ${responseTime}ms`);

        return {
            text: aiText,
            articles: articles.slice(0, 3), // Return top 3 articles as references
            metadata: {
                articlesFound: articles.length,
                searchQuery: query,
                responseTime
            }
        };
    } catch (error) {
        console.error('❌ Error generating AI response:', error.response?.data || error.message);
        console.error('❌ Full error details:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            config: {
                url: error.config?.url,
                method: error.config?.method,
                timeout: error.config?.timeout
            }
        });

        // Provide fallback response
        const fallbackResponse = articles.length > 0 ?
            `I found ${articles.length} relevant articles about "${query}", but I'm having trouble generating a detailed response right now. Here are the key articles I found:\n\n` +
            articles.slice(0, 3).map((article, idx) =>
                `[${idx + 1}] ${article.title} (${new Date(article.publishedAt).toLocaleDateString()})`
            ).join('\n') +
            '\n\nPlease try asking your question again or be more specific about what you\'d like to know.' :
            `I couldn't find relevant articles about "${query}" in our database. Try asking about recent Middle East news, Gulf region updates, business, sports, or current events.`;

        return {
            text: fallbackResponse,
            articles: articles.slice(0, 3),
            metadata: {
                articlesFound: articles.length,
                searchQuery: query,
                responseTime: 0,
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
        // Get recent popular articles from different categories
        const recentArticles = await Article.aggregate([
            {
                $match: {
                    language: 'english',
                    publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
                }
            },
            {
                $group: {
                    _id: '$category',
                    topArticle: { $first: '$$ROOT' },
                    count: { $sum: 1 }
                }
            },
            {
                $sort: { count: -1 }
            },
            {
                $limit: 4
            },
            {
                $project: {
                    category: '$_id',
                    title: '$topArticle.title',
                    count: 1
                }
            }
        ]);

        const suggestions = [
            'What are the latest news from UAE?',
            'Tell me about recent business developments in the Gulf',
            'What\'s happening in Saudi Arabia recently?',
            'Any updates on Qatar World Cup legacy?'
        ];

        // Add category-specific suggestions based on recent articles
        recentArticles.forEach(article => {
            if (article.category === 'business') {
                suggestions.push('What are the latest business news in the region?');
            } else if (article.category === 'sports') {
                suggestions.push('Any recent sports news from the Gulf?');
            } else if (article.category === 'politics') {
                suggestions.push('What are the recent political developments?');
            }
        });

        return suggestions.slice(0, 6); // Return max 6 suggestions
    } catch (error) {
        console.error('❌ Error getting suggestions:', error);
        return [
            'What are the latest news from UAE?',
            'Tell me about recent business developments',
            'Any sports updates from the region?',
            'What\'s happening in Saudi Arabia?'
        ];
    }
}

module.exports = {
    searchArticles,
    generateResponse,
    generateQueryEmbedding,
    getSuggestedQuestions
};