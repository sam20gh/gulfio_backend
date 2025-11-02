const Article = require('../models/Article');
const axios = require('axios');

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODEL = 'gpt-4o-mini'; // Using gpt-4o-mini as requested
const MAX_ARTICLES = 8; // Final articles after reranking
const VECTOR_INDEX_NAME = 'vec_full'; // New vector search index with embedding field
const VECTOR_CANDIDATES = 800; // Increased candidates for better quality
const VECTOR_LIMIT = 60; // More candidates for RRF fusion
const BM25_LIMIT = 30; // BM25 candidates
const RERANK_CANDIDATES = 40; // Total candidates sent to reranker

/**
 * Rerank articles using Cohere Rerank API
 */
async function rerankArticles(query, articles) {
    try {
        console.log(`🔄 Reranking ${articles.length} articles with Cohere...`);

        if (!COHERE_API_KEY) {
            console.log('⚠️ No Cohere API key, skipping reranking');
            return articles.slice(0, MAX_ARTICLES);
        }

        // Prepare documents for reranking
        const documents = articles.map(article => {
            const content = article.content ? 
                article.content.replace(/<[^>]*>/g, '').substring(0, 1000) : 
                article.title;
            return `${article.title}. ${content}`;
        });

        const response = await axios.post(
            'https://api.cohere.ai/v1/rerank',
            {
                model: 'rerank-english-v3.0',
                query: query,
                documents: documents,
                top_n: MAX_ARTICLES,
                return_documents: true
            },
            {
                headers: {
                    'Authorization': `Bearer ${COHERE_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        console.log(`✅ Cohere rerank completed, selected ${response.data.results.length} articles`);

        // Map reranked results back to original articles
        const rerankedArticles = response.data.results.map(result => {
            const originalArticle = articles[result.index];
            return {
                ...originalArticle,
                rerankScore: result.relevance_score
            };
        });

        console.log('📊 Rerank scores:', rerankedArticles.map(a => 
            `${a.title.substring(0, 50)}... (${a.rerankScore?.toFixed(4)})`
        ));

        return rerankedArticles;
    } catch (error) {
        console.error('❌ Error in Cohere reranking:', error.response?.data || error.message);
        console.log('🔄 Falling back to original ranking');
        return articles.slice(0, MAX_ARTICLES);
    }
}

/**
 * Reciprocal Rank Fusion (RRF) to combine vector and BM25 search results
 */
function fuseSearchResults(vectorResults, bm25Results, k = 60) {
    console.log(`🔀 Fusing ${vectorResults.length} vector + ${bm25Results.length} BM25 results`);
    
    const fusedScores = new Map();
    
    // Process vector search results
    vectorResults.forEach((article, index) => {
        const id = article._id.toString();
        const rrfScore = 1 / (k + index + 1); // RRF formula
        fusedScores.set(id, {
            article,
            vectorRank: index + 1,
            vectorScore: article.vectorScore || 0,
            bm25Rank: null,
            bm25Score: 0,
            rrfScore: rrfScore
        });
    });
    
    // Process BM25 results and add to fusion
    bm25Results.forEach((article, index) => {
        const id = article._id.toString();
        const rrfScore = 1 / (k + index + 1);
        
        if (fusedScores.has(id)) {
            // Article found in both searches - boost the score
            const existing = fusedScores.get(id);
            existing.bm25Rank = index + 1;
            existing.bm25Score = article.bm25Score || 0;
            existing.rrfScore += rrfScore; // Add RRF scores
        } else {
            // Article only in BM25 results
            fusedScores.set(id, {
                article,
                vectorRank: null,
                vectorScore: 0,
                bm25Rank: index + 1,
                bm25Score: article.bm25Score || 0,
                rrfScore: rrfScore
            });
        }
    });
    
    // Sort by combined RRF score and return top candidates
    const sortedResults = Array.from(fusedScores.values())
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .slice(0, RERANK_CANDIDATES);
    
    console.log(`✅ RRF fusion produced ${sortedResults.length} candidates`);
    console.log('📊 Top 5 RRF scores:', sortedResults.slice(0, 5).map(r => 
        `${r.article.title.substring(0, 40)}... (RRF: ${r.rrfScore.toFixed(4)}, V:${r.vectorRank || 'N/A'}, B:${r.bm25Rank || 'N/A'})`
    ));
    
    return sortedResults.map(result => ({
        ...result.article,
        fusionData: {
            rrfScore: result.rrfScore,
            vectorRank: result.vectorRank,
            bm25Rank: result.bm25Rank,
            vectorScore: result.vectorScore,
            bm25Score: result.bm25Score
        }
    }));
}

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
                dimensions: 128 // Match your embedding_pca dimensions
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
/**
 * Advanced search pipeline with Vector Search + BM25 + RRF Fusion + Cohere Reranking
 */
async function searchArticles(query, category = null, userId = null, usePersonalization = true) {
    try {
        console.log('🔍 Starting advanced search pipeline for query:', query);
        console.log('🔍 Search parameters:', { category, userId, usePersonalization });

        // Step 1: Generate embedding using OpenAI
        console.log('📊 Step 1: Creating embedding with OpenAI...');
        const queryEmbedding = await generateQueryEmbedding(query);

        // Step 2: Atlas Vector Search (semantic search)
        console.log('📊 Step 2: Running Atlas Vector Search...');
        const vectorResults = await performVectorSearch(query, queryEmbedding, category);

        // Step 3: BM25 Search (keyword search)
        console.log('📊 Step 3: Running BM25 keyword search...');
        const bm25Results = await performBM25Search(query, category);

        // Step 4: RRF Fusion to combine results
        console.log('📊 Step 4: Applying RRF fusion...');
        const fusedResults = fuseSearchResults(vectorResults, bm25Results);

        // Step 5: Cohere Reranking for final selection
        console.log('📊 Step 5: Reranking with Cohere...');
        const finalResults = await rerankArticles(query, fusedResults);

        console.log(`✅ Advanced search pipeline completed: ${finalResults.length} final articles`);
        return finalResults;

    } catch (error) {
        console.error('❌ Error in advanced search pipeline:', error);
        // Fallback to simple text search
        console.log('🔄 Falling back to simple text search...');
        return await fallbackTextSearch(query, category);
    }
}

/**
 * Perform Atlas Vector Search using the vec_full index
 */
async function performVectorSearch(query, queryEmbedding, category = null) {
    try {
        const matchConditions = {
            language: 'english'
        };

        if (category && category !== 'all') {
            matchConditions.category = category;
        }

        const pipeline = [
            {
                $vectorSearch: {
                    index: VECTOR_INDEX_NAME, // vec_full index
                    path: 'embedding', // using embedding field instead of embedding_pca
                    queryVector: queryEmbedding,
                    numCandidates: VECTOR_CANDIDATES, // 800 candidates
                    limit: VECTOR_LIMIT // 60 results
                }
            },
            {
                $addFields: {
                    vectorScore: { $meta: 'vectorSearchScore' }
                }
            }
        ];

        // Add category filter if specified
        if (Object.keys(matchConditions).length > 0) {
            pipeline.push({
                $match: matchConditions
            });
        }

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
                vectorScore: 1
            }
        });

        const results = await Article.aggregate(pipeline);
        console.log(`🔍 Vector search found ${results.length} articles`);
        
        return results;
    } catch (error) {
        console.error('❌ Vector search failed:', error);
        return [];
    }
}

/**
 * Perform BM25 keyword search using MongoDB text search
 */
async function performBM25Search(query, category = null) {
    try {
        const matchConditions = {
            $text: { $search: query },
            language: 'english'
        };

        if (category && category !== 'all') {
            matchConditions.category = category;
        }

        const results = await Article.find(matchConditions, {
            bm25Score: { $meta: 'textScore' }
        })
        .sort({ bm25Score: { $meta: 'textScore' } })
        .limit(BM25_LIMIT)
        .select('_id title content url category publishedAt image viewCount sourceGroupName')
        .lean();

        console.log(`🔍 BM25 search found ${results.length} articles`);
        return results;
    } catch (error) {
        console.error('❌ BM25 search failed:', error);
        return [];
    }
}        // Generate embedding for the query
        const queryEmbedding = await generateQueryEmbedding(query);

        // For sports queries, use hybrid search approach
        if (isSportsQuery && !category) {
            console.log('🔍 Using hybrid search for sports query...');

            // First try vector search with sports category preference
            const vectorResults = await Article.aggregate([
                {
                    $vectorSearch: {
                        index: VECTOR_INDEX_NAME,
                        path: 'embedding_pca',
                        queryVector: queryEmbedding,
                        numCandidates: 300,
                        limit: MAX_ARTICLES * 2
                    }
                },
                {
                    $addFields: {
                        vectorScore: { $meta: 'vectorSearchScore' },
                        // Boost sports category articles
                        categoryBoost: {
                            $cond: {
                                if: { $eq: ['$category', 'sports'] },
                                then: 0.3,
                                else: 0
                            }
                        },
                        finalScore: {
                            $add: [
                                { $meta: 'vectorSearchScore' },
                                {
                                    $cond: {
                                        if: { $eq: ['$category', 'sports'] },
                                        then: 0.3,
                                        else: 0
                                    }
                                }
                            ]
                        }
                    }
                },
                {
                    $match: {
                        language: 'english'
                    }
                },
                {
                    $sort: { finalScore: -1 }
                },
                {
                    $limit: MAX_ARTICLES
                },
                {
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
                        vectorScore: 1,
                        finalScore: 1
                    }
                }
            ]);

            // Always supplement with recent sports articles for sports queries
            const sportsArticlesFound = vectorResults.filter(article => article.category === 'sports').length;
            
            console.log('🔍 Supplementing with recent sports articles...');
            
            // Get recent sports articles with keyword matching
            const queryKeywords = query.toLowerCase().split(' ').filter(word => word.length > 2);
            const keywordRegex = queryKeywords.length > 0 ? queryKeywords.join('|') : 'sport';
            
            const directSportsResults = await Article.find({
                category: 'sports',
                language: 'english',
                $or: [
                    { title: { $regex: keywordRegex, $options: 'i' } },
                    { content: { $regex: keywordRegex, $options: 'i' } }
                ]
            })
            .sort({ publishedAt: -1 })
            .limit(MAX_ARTICLES)
            .select('_id title content url category publishedAt image viewCount sourceGroupName')
            .lean();

            // If no keyword matches, get latest sports articles
            let supplementaryResults = directSportsResults;
            if (supplementaryResults.length === 0) {
                console.log('🔍 No keyword matches, getting latest sports articles...');
                supplementaryResults = await Article.find({
                    category: 'sports',
                    language: 'english'
                })
                .sort({ publishedAt: -1 })
                .limit(MAX_ARTICLES)
                .select('_id title content url category publishedAt image viewCount sourceGroupName')
                .lean();
            }

            // Combine and deduplicate results, prioritizing sports articles
            const seenIds = new Set(vectorResults.map(article => article._id.toString()));
            const uniqueSportsResults = supplementaryResults.filter(article => 
                !seenIds.has(article._id.toString())
            );

            // Prioritize sports articles: take sports first, then fill with vector results
            const sportsFirst = [...uniqueSportsResults.slice(0, 6), ...vectorResults.filter(a => a.category !== 'sports')]
                .slice(0, MAX_ARTICLES);
            
            const totalSports = sportsFirst.filter(a => a.category === 'sports').length;
            console.log(`✅ Hybrid search found ${sportsFirst.length} articles (${totalSports} sports)`);
            return sportsFirst;            console.log(`✅ Vector search found ${vectorResults.length} articles (${sportsArticlesFound} sports)`);
            return vectorResults;
        }

        // Standard vector search for non-sports queries
        const pipeline = [
            {
                $vectorSearch: {
                    index: VECTOR_INDEX_NAME,
                    path: 'embedding_pca', // Using your embedding_pca field
                    queryVector: queryEmbedding,
                    numCandidates: 200, // Increased for better quality
                    limit: MAX_ARTICLES * 3 // Get more candidates for filtering and diversity
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

        // Recent articles preference (last 60 days)
        const recentDate = new Date();
        recentDate.setDate(recentDate.getDate() - 60);

        if (Object.keys(matchConditions).length > 0) {
            pipeline.push({
                $match: matchConditions
            });
        }

        // Add relevance scoring
        pipeline.push({
            $addFields: {
                relevanceScore: { $meta: 'vectorSearchScore' },
                recencyBoost: {
                    $cond: {
                        if: { $gte: ['$publishedAt', recentDate] },
                        then: 1.2,
                        else: 1.0
                    }
                },
                viewBoost: {
                    $cond: {
                        if: { $gte: ['$viewCount', 100] },
                        then: 1.1,
                        else: 1.0
                    }
                }
            }
        });

        // Calculate final score
        pipeline.push({
            $addFields: {
                finalScore: {
                    $multiply: ['$relevanceScore', '$recencyBoost', '$viewBoost']
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

        const results = await Article.aggregate(pipeline);
        console.log(`🔍 Vector search found ${results.length} articles`);
        
        return results;
    } catch (error) {
        console.error('❌ Vector search failed:', error);
        return [];
    }
}

/**
 * Fallback text search if vector search fails
 */
async function fallbackTextSearch(query, category = null) {
    try {
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

        const articles = await Article.find(matchConditions)
            .sort({ publishedAt: -1, viewCount: -1 })
            .limit(MAX_ARTICLES)
            .select('_id title content url category publishedAt image viewCount sourceGroupName')
            .lean();

        console.log(`✅ Fallback search found ${articles.length} articles for keywords: ${keywords.join(', ')}`);

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