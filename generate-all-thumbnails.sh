#!/bin/bash

# Thumbnail Generation Script
# Usage: ./generate-all-thumbnails.sh [batch_size]

BATCH_SIZE=${1:-20}  # Default to 20 videos per batch
BACKEND_DIR="/Users/sam/Desktop/gulfio/backend"

echo "🎬 Starting Thumbnail Generation Process..."
echo "📊 Batch size: $BATCH_SIZE videos per batch"
echo ""

cd "$BACKEND_DIR"

# Get initial statistics
echo "📊 Getting current statistics..."
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('./models/Reel');

mongoose.connect(process.env.MONGO_URI).then(async () => {
    const [total, withThumbnails] = await Promise.all([
        Reel.countDocuments(),
        Reel.countDocuments({ thumbnailUrl: { \$exists: true, \$ne: null, \$ne: '' } })
    ]);
    
    const remaining = total - withThumbnails;
    console.log('   Total Videos:', total);
    console.log('   With Thumbnails:', withThumbnails);
    console.log('   Remaining:', remaining);
    console.log('   Coverage:', ((withThumbnails / total) * 100).toFixed(1) + '%');
    console.log('');
    process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
"

echo "🚀 Starting batch processing..."
echo "Press Ctrl+C to stop at any time"
echo ""

BATCH_COUNT=1

while true; do
    echo "📦 Processing Batch $BATCH_COUNT (up to $BATCH_SIZE videos)..."
    
    # Run batch generation
    node batch-thumbnails.js $BATCH_SIZE
    
    # Check the exit code
    if [ $? -ne 0 ]; then
        echo "❌ Batch processing failed or interrupted"
        break
    fi
    
    # Quick check if we're done
    REMAINING=$(node -e "
    require('dotenv').config();
    const mongoose = require('mongoose');
    const Reel = require('./models/Reel');
    
    mongoose.connect(process.env.MONGO_URI).then(async () => {
        const remaining = await Reel.countDocuments({
            \$or: [
                { thumbnailUrl: { \$exists: false } },
                { thumbnailUrl: null },
                { thumbnailUrl: '' }
            ]
        });
        console.log(remaining);
        process.exit(0);
    }).catch(() => process.exit(1));
    ")
    
    if [ "$REMAINING" = "0" ]; then
        echo ""
        echo "🎉 ALL THUMBNAILS GENERATED!"
        echo "✅ Processing complete!"
        break
    fi
    
    echo ""
    echo "⏳ Waiting 30 seconds before next batch..."
    echo "📋 Videos remaining: $REMAINING"
    echo ""
    sleep 30
    
    BATCH_COUNT=$((BATCH_COUNT + 1))
done

echo ""
echo "📊 Final Statistics:"
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('./models/Reel');

mongoose.connect(process.env.MONGO_URI).then(async () => {
    const [total, withThumbnails] = await Promise.all([
        Reel.countDocuments(),
        Reel.countDocuments({ thumbnailUrl: { \$exists: true, \$ne: null, \$ne: '' } })
    ]);
    
    console.log('   Total Videos:', total);
    console.log('   With Thumbnails:', withThumbnails);
    console.log('   Coverage:', ((withThumbnails / total) * 100).toFixed(1) + '%');
    process.exit(0);
}).catch(() => process.exit(1));
"

echo ""
echo "🎬 Thumbnail generation session complete!"
