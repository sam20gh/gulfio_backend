#!/bin/bash

# Script to clear all caches and force fresh personalized articles

echo "🧹 Clearing all backend caches for fresh personalized articles..."

# 1. Clear Redis cache for personalized articles
echo "1. Clearing Redis cache..."
cd /Users/sam/Desktop/gulfio/backend

# Create a script to clear Redis cache via the API
node -e "
const redis = require('./utils/redis');

async function clearCache() {
  try {
    // Clear all article-related cache keys
    const keys = await redis.keys('articles_personalized_*');
    if (keys.length > 0) {
      await redis.del(keys);
      console.log('✅ Cleared personalized article cache keys:', keys.length);
    } else {
      console.log('ℹ️  No personalized article cache keys found');
    }
    
    // Also clear regular article cache
    const allKeys = await redis.keys('articles_*');
    if (allKeys.length > 0) {
      await redis.del(allKeys);
      console.log('✅ Cleared all article cache keys:', allKeys.length);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    process.exit(1);
  }
}

clearCache();
"

echo "2. Restarting local backend server (if running)..."
# Kill any existing local backend process
pkill -f "node.*server.js" || echo "No local backend process found"

echo "3. For production deployment, run: ./deploy.sh"
echo "   (Note: Fix Google Cloud permissions first)"

echo "✅ Cache clearing completed!"
