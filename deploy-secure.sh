#!/bin/bash

# Secure deployment script - sources environment variables from .env file
# This way secrets are not hardcoded in the script

# Source environment variables
if [ -f ".env" ]; then
    echo "📄 Loading environment variables from .env file..."
    source .env
else
    echo "❌ .env file not found. Please create it with your environment variables."
    echo "💡 See .env.example for required variables"
    exit 1
fi

# Run the main deployment script
echo "🚀 Starting deployment with environment variables..."
./deploy.sh
