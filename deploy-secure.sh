#!/bin/bash

# Secure deployment script - sources environment variables from .env file
# This way secrets are not hardcoded in the script

# Source environment variables
if [ -f ".env" ]; then
    echo "📄 Loading environment variables from .env file..."
    # Export all variables from .env file
    export $(grep -v '^#' .env | xargs)
    echo "✅ Environment variables loaded successfully"
    
    # Verify key variables are set
    if [ -z "$MONGO_URI" ] || [ -z "$AWS_S3_REGION" ] || [ -z "$OPENAI_API_KEY" ]; then
        echo "❌ Critical environment variables are missing after loading .env"
        echo "Please check your .env file format"
        exit 1
    fi
    
    echo "🔧 Key variables confirmed: MONGO_URI, AWS_S3_REGION, OPENAI_API_KEY"
else
    echo "❌ .env file not found. Please create it with your environment variables."
    echo "💡 See .env.example for required variables"
    exit 1
fi

# Run the main deployment script
echo "🚀 Starting deployment with environment variables..."
./deploy.sh
