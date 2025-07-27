#!/bin/bash

echo "🚀 Starting Backend Local Testing..."

# Check if we're in the backend directory
if [ ! -f "server.js" ]; then
    echo "❌ Error: server.js not found. Please run this from the backend directory."
    exit 1
fi

# Check if MongoDB URI is set
if [ -z "$MONGO_URI" ]; then
    echo "⚠️  MONGO_URI not set, checking .env file..."
    if [ -f ".env" ]; then
        echo "✅ .env file found"
    else
        echo "❌ No .env file found. Please ensure environment is configured."
        exit 1
    fi
fi

echo "🔧 Environment Check:"
echo "   - Node.js version: $(node --version)"
echo "   - NPM version: $(npm --version)"
echo "   - MongoDB URI: $(echo $MONGO_URI | cut -c1-30)..."

echo ""
echo "🚀 Starting server on port 8080..."
echo "📋 You can test the following endpoints:"
echo "   - Health check: http://localhost:8080/api/articles"
echo "   - Auth test: http://localhost:8080/api/debug/auth-test"
echo "   - Personalized articles: http://localhost:8080/api/articles/personalized"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

node server.js
