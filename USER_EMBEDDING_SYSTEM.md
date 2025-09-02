# User Embedding Updates System

This system ensures that user embeddings and PCA embeddings are updated based on their activities (likes, dislikes, views, saves).

## Overview

All users currently have empty `embedding` and `embedding_pca` arrays. This system will:

1. **Update embeddings based on user activities** - Generate embeddings from articles users have liked, viewed, saved
2. **Convert embeddings to PCA format** - Reduce dimensions from 1536D to 128D for better performance 
3. **Update embeddings on every article action** - Ensure embeddings stay current as users interact with articles

## Files Created/Modified

### 1. New Script: `scripts/updateAllUserEmbeddings.js`

**Purpose**: One-time script to populate embeddings for all users with empty embeddings

**Features**:
- Finds users with empty embedding or embedding_pca arrays
- Generates weighted embeddings based on user activities
- Converts to PCA format for better performance 
- Updates disliked categories for content filtering
- Activity weights:
  - Liked articles: 3.0x weight (strongest positive signal)
  - Saved articles: 2.5x weight (high interest)
  - Viewed articles: 1.0x weight (basic engagement)
  - Disliked articles: Tracked separately for negative filtering

**Usage**:
```bash
cd backend
node scripts/updateAllUserEmbeddings.js
```

### 2. Enhanced: `utils/userEmbedding.js`

**Purpose**: Real-time embedding updates triggered by user actions

**Improvements**:
- Added PCA conversion using `convertToPCAEmbedding`
- Weighted activity processing (same weights as script)
- Better error handling and logging
- Updates both `embedding` and `embedding_pca` fields
- Tracks `disliked_categories` for content filtering

### 3. Existing Integration Points

The following backend endpoints already call `updateUserProfileEmbedding()`:

#### Article Actions:
- **Like/Dislike**: `POST /api/user/article/:id/like` ✅
- **Save/Unsave**: `POST /api/user/article/:id/save` ✅

This means that whenever a user:
- Likes an article
- Dislikes an article  
- Saves an article
- Unsaves an article

Their embedding profile is automatically updated to reflect their new preferences.

## How It Works

### Embedding Generation Process

1. **Collect User Activities**: 
   - Get liked articles (3x weight)
   - Get saved articles (2.5x weight)  
   - Get viewed articles (1x weight)
   - Track disliked categories separately

2. **Create Weighted Profile Text**:
   - Combine article titles and content snippets
   - Repeat text based on activity weight for emphasis
   - Example: Liked articles appear 3 times in the profile text

3. **Generate Embedding**:
   - Send profile text to DeepSeek API
   - Get 1536-dimensional embedding vector

4. **Convert to PCA**:
   - Use trained PCA model to reduce to 128 dimensions
   - Better performance for similarity calculations

5. **Update Database**:
   - Store both `embedding` (1536D) and `embedding_pca` (128D)
   - Update `disliked_categories` array
   - Set `updatedAt` timestamp

### Real-time Updates

Every time a user performs an action (like, save, etc.), the system:

1. **Frontend** → Makes API call to backend
2. **Backend** → Updates user's activity arrays in database
3. **Backend** → Calls `updateUserProfileEmbedding(userId)`
4. **Embedding System** → Regenerates user's embedding profile
5. **PCA Conversion** → Creates optimized 128D version
6. **Database** → Stores updated embeddings

## Benefits

### For Users:
- **Better Recommendations**: Articles matched to their actual interests
- **Real-time Learning**: System adapts as preferences evolve
- **Content Filtering**: Avoided disliked categories

### For System:
- **Performance**: 128D PCA embeddings are faster to compute
- **Accuracy**: Weighted activities provide better preference signals
- **Scalability**: Efficient similarity calculations

### For Recommendations:
- **Personalization**: Each user gets content matched to their embedding
- **Diversity**: System avoids over-recommending from disliked categories  
- **Freshness**: Embeddings update with each user action

## Monitoring

The system logs detailed information for monitoring:

```javascript
✅ Generated embedding (1536D) for user user@example.com
✅ Generated PCA embedding (128D) for user user@example.com  
✅ Updated embeddings for user user@example.com
```

## Running the Initial Update

To populate embeddings for all existing users:

```bash
# Navigate to backend directory
cd backend

# Run the update script
node scripts/updateAllUserEmbeddings.js
```

Expected output:
```
🔌 Connecting to MongoDB...
✅ Connected to MongoDB
🔄 Initializing PCA model...
📊 Found 150 users with empty embeddings
📊 Processing user 1/150
✅ Success: 1536D embedding, 128D PCA
...
📊 Summary:
✅ Successfully updated: 145 users
❌ Failed: 5 users
📋 Total processed: 150 users
```

## Error Handling

The system is designed to be resilient:

- **Embedding API Failures**: Logged but don't break user actions
- **PCA Conversion Failures**: Falls back to empty PCA array
- **Database Issues**: User actions still complete successfully
- **No Activities**: Users with no activities get empty embeddings

This ensures that user experience is never impacted by the embedding system.
