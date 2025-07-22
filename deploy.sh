#!/bin/bash

# Deployment script for Gulfio Backend to Google Cloud Run
# This script should be run from the backend directory

echo "🚀 Deploying Gulfio Backend to Google Cloud Run..."

# Check if we're in the right directory
if [ ! -f "app.js" ]; then
    echo "❌ Error: app.js not found. Please run this script from the backend directory."
    exit 1
fi

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI is not installed."
    echo "Please install it from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Set project details
PROJECT_ID="gulfio-backend"
SERVICE_NAME="gulfio-backend"
REGION="me-central1"

echo "📋 Project: $PROJECT_ID"
echo "📋 Service: $SERVICE_NAME"
echo "📋 Region: $REGION"

# Build and deploy
echo "🔨 Building and deploying to Cloud Run..."

gcloud run deploy $SERVICE_NAME \
    --source . \
    --platform managed \
    --region $REGION \
    --project $PROJECT_ID \
    --allow-unauthenticated \
    --memory 2Gi \
    --cpu 1 \
    --min-instances 0 \
    --max-instances 10 \
    --port 8080

if [ $? -eq 0 ]; then
    echo "✅ Deployment successful!"
    echo "🌐 Service URL: https://$SERVICE_NAME-180255041979.$REGION.run.app"
else
    echo "❌ Deployment failed!"
    exit 1
fi
