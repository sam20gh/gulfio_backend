# Secure Deployment Guide

## 🔒 Security Issue Fixed

The previous `deploy.sh` contained hardcoded API keys and secrets, which GitHub correctly blocked due to push protection. This has been fixed with a secure deployment approach.

## 🚀 How to Deploy

### Option 1: Use the secure deployment script (Recommended)
```bash
./deploy-secure.sh
```

This script will:
1. Load environment variables from `.env` file
2. Run the deployment with those variables

### Option 2: Set environment variables manually
```bash
# Set your environment variables
export MONGO_URI="your-mongodb-connection-string"
export OPENAI_API_KEY="your-openai-api-key"
# ... set other variables

# Then run deployment
./deploy.sh
```

## 📁 File Structure

- `.env` - Contains actual secrets (NOT committed to git)
- `.env.example` - Template showing required variables
- `deploy.sh` - Main deployment script (now secure)
- `deploy-secure.sh` - Helper script that loads .env and deploys

## ⚠️ Important Security Notes

1. **Never commit `.env` files** - They contain secrets
2. **Use `.env.example`** as a template for required variables
3. **The `.env` file is in `.gitignore`** to prevent accidental commits
4. **Environment variables are only loaded at deployment time**

## 🔧 Environment Variables Required

See `.env.example` for the complete list of required environment variables.

## 🎯 GitHub Push Protection

This fix resolves the GitHub push protection error:
- ✅ No more hardcoded secrets in scripts
- ✅ Safe to commit to version control
- ✅ Secrets are loaded from external `.env` file only during deployment
