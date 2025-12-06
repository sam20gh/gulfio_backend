// OPTIMIZED personalized-light endpoint for <2s performance
// This version eliminates the populate() bottleneck and uses better indexing

articleRouter.get('/personalized-light-optimized', auth, ensureMongoUser, async (req, res) => {
    const startTime = Date.now();

    try {
        const userId = req.mongoUser.supabase_id;
        const language = req.query.language || 'english';
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const forceRefresh = req.query.noCache === 'true';

        console.log(`🚀 OPTIMIZED Light personalized for user ${userId}, limit ${limit}, lang: ${language}, forceRefresh: ${forceRefresh}`);

        // Check cache first with better cache key
        const hourSlot = Math.floor(Date.now() / (60 * 60 * 1000)); // Hourly cache slots
        const cacheKey = `articles_light_optimized_${language}_${limit}_${hourSlot}`;

        let cached;
        if (!forceRefresh) {
            try {
                cached = await redis.get(cacheKey);
                if (cached) {
                    const result = JSON.parse(cached);
                    console.log(`⚡ OPTIMIZED cache hit in ${Date.now() - startTime}ms - ${result.length} articles`);
                    return res.json(result);
                }
            } catch (err) {
                console.error('⚠️ Redis get error:', err.message);
            }
        }

        console.log(`🔍 OPTIMIZED: Starting aggregation query for ${language} language`);
        const queryStart = Date.now();

        // OPTIMIZATION 1: Use aggregation pipeline instead of populate()
        // OPTIMIZATION 2: Reduce time window to 12 hours for ultra-speed
        // OPTIMIZATION 3: Use $lookup only when needed and optimize it

        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

        const articles = await Article.aggregate([
            {
                // Stage 1: Match with optimized filter (use compound index)
                $match: {
                    language: language,
                    publishedAt: { $gte: twelveHoursAgo }
                }
            },
            {
                // Stage 2: Sort BEFORE lookup for better performance
                $sort: { publishedAt: -1 }
            },
            {
                // Stage 3: Limit early to reduce lookup operations
                $limit: limit * 2
            },
            {
                // Stage 4: Optimized lookup with only required fields
                $lookup: {
                    from: 'sources',
                    localField: 'sourceId',
                    foreignField: '_id',
                    as: 'sourceData',
                    pipeline: [
                        {
                            $project: {
                                name: 1,
                                icon: 1,
                                groupName: 1
                            }
                        }
                    ]
                }
            },
            {
                // Stage 5: Unwind and add source fields directly
                $addFields: {
                    sourceInfo: { $arrayElemAt: ['$sourceData', 0] },
                    sourceName: { $arrayElemAt: ['$sourceData.name', 0] },
                    sourceIcon: { $arrayElemAt: ['$sourceData.icon', 0] },
                    sourceGroupName: { $arrayElemAt: ['$sourceData.groupName', 0] }
                }
            },
            {
                // Stage 6: Project final fields (remove unnecessary data)
                $project: {
                    title: 1,
                    content: 1,
                    contentFormat: 1,
                    url: 1,
                    category: 1,
                    publishedAt: 1,
                    image: 1,
                    viewCount: 1,
                    likes: 1,
                    dislikes: 1,
                    likedBy: 1,
                    dislikedBy: 1,
                    sourceId: 1,
                    sourceName: 1,
                    sourceIcon: 1,
                    sourceGroupName: 1,
                    language: 1, // Include language for RTL support
                    // Add performance markers
                    isLight: { $literal: true },
                    fetchedAt: { $literal: new Date() },
                    isRefreshed: { $literal: forceRefresh },
                    fetchId: { $literal: new mongoose.Types.ObjectId().toString() }
                }
            }
        ]);

        console.log(`⚡ OPTIMIZED DB aggregation completed in ${Date.now() - queryStart}ms - found ${articles.length} articles`);

        // OPTIMIZATION 4: Simple source group limiting (faster than complex grouping)
        const limitedResponse = [];
        const sourceGroupCounts = new Map();

        for (const article of articles) {
            const sourceGroup = article.sourceGroupName || 'unknown';
            const count = sourceGroupCounts.get(sourceGroup) || 0;

            if (count < 2 && limitedResponse.length < limit) {
                limitedResponse.push(article);
                sourceGroupCounts.set(sourceGroup, count + 1);
            }

            if (limitedResponse.length >= limit) break;
        }

        console.log(`🔀 OPTIMIZED: Limited from ${articles.length} to ${limitedResponse.length} articles (max 2 per source group)`);

        // OPTIMIZATION 5: Longer cache with hourly slots
        try {
            await redis.set(cacheKey, JSON.stringify(limitedResponse), 'EX', 1800); // 30 min cache
        } catch (err) {
            console.error('⚠️ Redis set error:', err.message);
        }

        const totalTime = Date.now() - startTime;
        console.log(`🚀 OPTIMIZED Light personalized complete in ${totalTime}ms - ${limitedResponse.length} articles`);

        // Add performance headers for monitoring
        res.setHeader('X-Performance-Time', totalTime);
        res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
        res.setHeader('X-Optimization-Applied', 'aggregation-pipeline');

        res.json(limitedResponse);

    } catch (error) {
        const errorTime = Date.now() - startTime;
        console.error(`❌ OPTIMIZED Light personalized error in ${errorTime}ms:`, error);

        // Fallback to basic query if aggregation fails
        console.log('🔄 Falling back to basic query...');
        try {
            const fallbackArticles = await Article.find({
                language: req.query.language || 'english',
                publishedAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } // 6 hours
            })
                .select('title content url category publishedAt image sourceId viewCount likes dislikes')
                .sort({ publishedAt: -1 })
                .limit(limit)
                .lean();

            console.log(`🔄 Fallback completed with ${fallbackArticles.length} articles`);
            res.json(fallbackArticles);
        } catch (fallbackError) {
            console.error('❌ Fallback also failed:', fallbackError);
            res.status(500).json({ error: 'Optimized light personalized error', message: error.message });
        }
    }
});

// SUPPORTING OPTIMIZATION: Create proper indexes
// Run this once to ensure optimal database performance:
/*
db.articles.createIndex({ language: 1, publishedAt: -1 }) // Compound index for filter + sort
db.articles.createIndex({ publishedAt: -1, language: 1 }) // Alternative compound index
db.articles.createIndex({ sourceId: 1 }) // For lookups
db.sources.createIndex({ _id: 1 }) // Ensure source lookups are fast
*/
