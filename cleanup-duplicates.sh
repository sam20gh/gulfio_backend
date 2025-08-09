#!/bin/bash

echo "🧹 Starting duplicate article cleanup..."
echo "This will remove duplicate articles from the database."
echo ""

read -p "Are you sure you want to continue? (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Running duplicate cleanup script..."
    node scripts/remove-duplicates.js
else
    echo "❌ Cleanup cancelled."
fi
