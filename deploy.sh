#!/bin/bash

# Deployment script for Gulfio Backend to Google Cloud Run
# This script should be run from the backend directory

echo "🚀 Deploying Gulfio Backend to Google Cloud Run..."

# Check if we're in the right directory
if [ ! -f "app.js" ]; then
    echo "❌ Error: app.js not found. Please run this script from the backend directory."
    exit 1
fi

# Load .env into the shell so every --set-env-vars "${VAR}" below actually
# has a value. Without this, deploy just ships whatever was previously
# `export`ed in the current terminal — silently deploying blanks for any var
# that only exists in .env (bit us with CF_ACCOUNT_ID/CF_API_TOKEN: gcloud
# accepted the deploy fine, Cloudflare got an empty account id, and nothing
# in Cloud Run's own logs indicated a deploy-config problem).
if [ -f ".env" ]; then
    echo "📄 Loading environment variables from .env..."
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
else
    echo "⚠️  No .env file found — relying on already-exported shell variables."
fi

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: gcloud CLI is not installed."
    echo "Please install it from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Set project details
PROJECT_ID="grub24-217509"
SERVICE_NAME="gulfio-backend"
REGION="me-central1"

echo "📋 Project: $PROJECT_ID"
echo "📋 Service: $SERVICE_NAME"
echo "📋 Region: $REGION"

# Check if environment variables are set
if [ -z "$MONGO_URI" ] || [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️  Warning: Some environment variables are not set."
    echo "💡 To set them for this deployment, run:"
    echo "   export MONGO_URI='your-mongodb-connection-string'"
    echo "   export OPENAI_API_KEY='your-openai-api-key'"
    echo "   export ADMIN_API_KEY='your-admin-api-key'"
    echo "   # ... and other required variables"
    echo ""
    echo "📄 See .env.example for all required variables"
    echo ""
    read -p "Continue with deployment? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Deployment cancelled"
        exit 1
    fi
fi

# Build and deploy
echo "🔨 Building and deploying to Cloud Run..."

# Deploy with environment variables (secrets should be set externally)
gcloud run deploy $SERVICE_NAME \
    --source . \
    --platform managed \
    --region $REGION \
    --project $PROJECT_ID \
    --allow-unauthenticated \
    --memory 8Gi \
    --cpu 2 \
    --min-instances 2 \
    --max-instances 10 \
    --port 8080 \
    --set-env-vars MONGO_URI="${MONGO_URI}" \
    --set-env-vars ADMIN_API_KEY="${ADMIN_API_KEY}" \
    --set-env-vars SUPABASE_URL="${SUPABASE_URL}" \
    --set-env-vars SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY}" \
    --set-env-vars SUPABASE_JWT_ISSUER="${SUPABASE_JWT_ISSUER}" \
    --set-env-vars SUPABASE_JWT_SECRET="${SUPABASE_JWT_SECRET}" \
    --set-env-vars YOUTUBE_API_KEY="${YOUTUBE_API_KEY}" \
    --set-env-vars OPENAI_API_KEY="${OPENAI_API_KEY}" \
    --set-env-vars R2_ENDPOINT="${R2_ENDPOINT}" \
    --set-env-vars R2_PUBLIC_URL="${R2_PUBLIC_URL}" \
    --set-env-vars R2_ACCESS_KEY="${R2_ACCESS_KEY}" \
    --set-env-vars R2_SECRET_KEY="${R2_SECRET_KEY}" \
    --set-env-vars R2_BUCKET="${R2_BUCKET}" \
    --set-env-vars AWS_S3_BUCKET="${AWS_S3_BUCKET}" \
    --set-env-vars AWS_S3_REGION="${AWS_S3_REGION}" \
    --set-env-vars AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
    --set-env-vars AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
    --set-env-vars LOTTO_URL="${LOTTO_URL}" \
    --set-env-vars COHERE_API_KEY="${COHERE_API_KEY}" \
    --set-env-vars REDIS_URL="${REDIS_URL}" \
    --set-env-vars API_FOOTBALL_KEY="${API_FOOTBALL_KEY}" \
    --set-env-vars API_FOOTBALL_BASE_URL="${API_FOOTBALL_BASE_URL}" \
    --set-env-vars GOLDAPI_KEY="${GOLDAPI_KEY}" \
    --set-env-vars AZURE_SPEECH_KEY="${AZURE_SPEECH_KEY}" \
    --set-env-vars AZURE_SPEECH_REGION="${AZURE_SPEECH_REGION}" \
    --set-env-vars TTS_AUDIO_ENABLED_FROM="${TTS_AUDIO_ENABLED_FROM}" \
    --set-env-vars CF_API_TOKEN="${CF_API_TOKEN}" \
    --set-env-vars CF_ACCOUNT_ID="${CF_ACCOUNT_ID}"
    

if [ $? -eq 0 ]; then
    echo "✅ Deployment successful!"
    echo "🌐 Service URL: https://$SERVICE_NAME-180255041979.$REGION.run.app"
else
    echo "❌ Deployment failed!"
    exit 1
fi
