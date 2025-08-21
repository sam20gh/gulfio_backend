# 🎯 Personalized Video Recommendations System

## Overview

The enhanced video recommendation system provides intelligent, personalized content delivery for logged-in users while maintaining engaging content for anonymous users. The system learns from user interactions and adapts content recommendations accordingly.

## 🚀 Key Features

### 1. **Smart User Profiling**
- Tracks user interactions (views, likes, dislikes, saves)
- Builds preference profiles based on sources and content categories
- Uses AI embeddings for content-based filtering
- Adapts strategy based on user engagement level

### 2. **Three-Tier Recommendation Strategy**

#### 🔍 **Discovery Mode** (New Users: 0-10 interactions)
- **30%** Fresh content (last 24 hours)
- **30%** Popular content (high view count)
- **25%** Trending content (high engagement)
- **15%** Random content for serendipity

#### ⚖️ **Balanced Mode** (Moderate Users: 10-50 interactions)
- **40%** Content from preferred sources
- **30%** Fresh content
- **20%** Popular content
- **10%** Random content

#### 🎯 **Personalized Mode** (Active Users: 50+ interactions)
- **50%** AI embedding-based recommendations
- **25%** Fresh content
- **15%** Trending content
- **10%** Random content for discovery

### 3. **Content Quality Controls**
- **Duplicate Prevention**: Excludes recently viewed content
- **Source Variety**: Max 33% from any single source
- **Intelligent Shuffling**: Maintains structure while randomizing
- **Engagement Boosting**: Prioritizes quality content

## 🛠️ API Endpoints

### Core Feed Endpoint
```
GET /api/videos/reels?sort=personalized&limit=10
```

**Query Parameters:**
- `sort`: `personalized` (default for logged users), `recent`, `random`, `mixed`
- `limit`: Number of reels (max 50)
- `page`: Page number for pagination
- `simple`: Return array only (no metadata)

**Response:**
```json
{
  "reels": [...],
  "personalization": {
    "strategy": "personalized",
    "userInteractions": 127,
    "preferredSources": [["CNN", 45], ["BBC", 32]],
    "contentMix": {
      "personalized": 5,
      "fresh": 3,
      "trending": 1,
      "random": 1
    }
  },
  "pagination": {...}
}
```

### User Interaction Tracking

#### View Tracking
```
POST /api/videos/reels/:reelId/view
```
```json
{
  "duration": 25  // optional: viewing duration in seconds
}
```

#### Like/Dislike/Save
```
POST /api/videos/reels/:reelId/like
POST /api/videos/reels/:reelId/dislike
POST /api/videos/reels/:reelId/save
```

### User Preferences
```
GET /api/videos/user/preferences
```

**Response:**
```json
{
  "preferences": {
    "sourcePreferences": [["CNN", 15], ["BBC", 12]],
    "categoryPreferences": [["News", 20], ["Sports", 8]],
    "totalInteractions": 127,
    "averageEmbedding": [0.1, -0.2, ...]
  },
  "recommendations": {
    "currentStrategy": "personalized",
    "availableStrategies": ["discovery", "balanced", "personalized"]
  }
}
```

### Bulk Interaction Status
```
POST /api/videos/reels/interaction-status
```
```json
{
  "reelIds": ["64f...", "64e..."]
}
```

**Response:**
```json
{
  "interactions": {
    "64f...": {
      "isLiked": true,
      "isDisliked": false,
      "isSaved": false,
      "isViewed": true
    }
  }
}
```

## 📱 Frontend Integration

### 1. **Authentication-Aware Requests**
```javascript
const headers = {
  'Authorization': `Bearer ${userToken}`,
  'Content-Type': 'application/json'
};

// Personalized feed for logged-in users
const response = await fetch('/api/videos/reels?sort=personalized', { headers });
```

### 2. **Track User Interactions**
```javascript
// Track view with duration
const trackView = async (reelId, duration) => {
  await fetch(`/api/videos/reels/${reelId}/view`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ duration })
  });
};

// Handle like button
const toggleLike = async (reelId) => {
  const response = await fetch(`/api/videos/reels/${reelId}/like`, {
    method: 'POST',
    headers
  });
  const data = await response.json();
  // Update UI with data.isLiked, data.likes
};
```

### 3. **Display Personalization Info**
```javascript
const { reels, personalization } = await response.json();

if (personalization) {
  console.log(`Strategy: ${personalization.strategy}`);
  console.log(`Content mix:`, personalization.contentMix);
  // Show user that content is personalized
}
```

## 🔧 Setup & Migration

### 1. **Run Database Migration**
```bash
cd backend
node migrate-personalization.js
```

### 2. **Test the System**
```bash
node test-personalization.js
```

### 3. **Monitor Performance**
- Check MongoDB slow query log
- Monitor API response times
- Track recommendation relevance metrics

## 📊 Performance Optimizations

### Database Indexes Added:
- `likedBy`, `dislikedBy`, `savedBy`, `viewedBy` (user interactions)
- `scrapedAt + viewCount` (recency + popularity)
- `likes + scrapedAt` (engagement + recency)  
- `embedding + scrapedAt` (AI recommendations)
- `userId + eventType + timestamp` (user activity)

### Caching Strategy:
- 5-minute cache for trending reels
- User preference caching (implement as needed)
- Embedding similarity results caching

## 🔐 Privacy & Data Management

### User Data Collected:
- Viewing history (90-day TTL)
- Interaction preferences (likes, saves)
- Content similarity profiles (anonymous embeddings)

### Privacy Controls:
```javascript
// Clear user history
POST /api/videos/user/clear-history
```

## 📈 Analytics & Monitoring

### Key Metrics to Track:
- **Engagement Rate**: Likes/views ratio improvement
- **Session Length**: Average viewing time per user
- **Content Discovery**: Variety of sources consumed
- **User Retention**: Return visit frequency
- **Recommendation Accuracy**: Click-through rates by strategy

### Logging Examples:
```
🎯 AI Recommendations: 10 reels selected {
  strategy: 'personalized',
  embeddingType: 'PCA (128d)',
  freshCount: 3,
  avgSimilarity: '0.847',
  sourcesUsed: 4
}
```

## 🚨 Troubleshooting

### Common Issues:

1. **Same content repeating**
   - Check if user token is being sent
   - Verify `viewedBy` tracking is working
   - Ensure sufficient content variety in database

2. **Poor personalization**
   - Check user interaction count
   - Verify embeddings are generated for content
   - Review content mixing ratios

3. **Slow response times**
   - Run migration to add indexes
   - Check MongoDB query performance
   - Consider implementing caching

### Debug Endpoints:
```
GET /api/videos/reels/debug  // Check content distribution
GET /api/videos/user/preferences  // Verify user profiling
```

## 🔄 Future Enhancements

- **Real-time recommendations** using WebSockets
- **Cross-platform sync** for user preferences  
- **A/B testing framework** for recommendation strategies
- **Content similarity clustering** for better discovery
- **Social recommendations** based on follower activity
- **Time-based personalization** (morning vs evening preferences)

---

*This system transforms the static video feed into an intelligent, adaptive experience that learns from each user's behavior and preferences while maintaining content discovery and variety.*
