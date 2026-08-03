#!/bin/bash
#
# Creates/updates two one-off Cloud Run Jobs for the database migrations:
#
#   gulfio-migrate-embeddings  -> articles.embedding: array of doubles -> Binary float32
#   gulfio-reproject-pca       -> retrain the canonical PCA basis + re-project everything
#
# Run this from Cloud Shell (or anywhere with gcloud + this repo). It only builds and
# registers the jobs — it does NOT execute them. Execute commands are printed at the end.
#
#   ./deploy-migration-job.sh [REGION]
#
set -euo pipefail

PROJECT_ID="grub24-217509"

# Pass --skip-build to re-register the jobs against the existing image (config-only
# changes) without paying for another build.
SKIP_BUILD=false
ARGS=()
for a in "$@"; do
    if [ "$a" = "--skip-build" ]; then SKIP_BUILD=true; else ARGS+=("$a"); fi
done

# Match the backend service's region so the job sits close to Atlas — these scripts are
# network-bound (they stream every article's embedding), so latency dominates runtime.
REGION="${ARGS[0]:-me-central1}"
IMAGE="gcr.io/${PROJECT_ID}/gulfio-db-migration:latest"

MIGRATE_JOB="gulfio-migrate-embeddings"
REPROJECT_JOB="gulfio-reproject-pca"

echo "📋 Project : $PROJECT_ID"
echo "📋 Region  : $REGION"
echo "📋 Image   : $IMAGE"

if [ ! -f "scripts/migrateEmbeddingsToBinaryVector.js" ]; then
    echo "❌ Run this from the backend/ directory."
    exit 1
fi

# MONGO_URI is only needed to configure the job; it is excluded from the build context
# by .gcloudignore and never baked into the image. These scripts need no other secret —
# they only move bytes and re-project existing vectors, never call the embedding API.
#
# Resolution order: existing env -> local .env -> read it back off the deployed backend
# service. The last one is what makes this work in Cloud Shell, where there is no .env
# and you should not have to paste a database password into a terminal.
if [ -z "${MONGO_URI:-}" ] && [ -f ".env" ]; then
    echo "📄 Loading .env"
    set -a
    # shellcheck disable=SC1091
    source ./.env
    set +a
fi

if [ -z "${MONGO_URI:-}" ]; then
    echo "🔎 No .env — reading MONGO_URI from the deployed gulfio-backend service..."
    MONGO_URI="$(gcloud run services describe gulfio-backend \
        --region="$REGION" --project="$PROJECT_ID" --format=json 2>/dev/null \
        | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="MONGO_URI") | .value')"
fi

if [ -z "${MONGO_URI:-}" ] || [ "$MONGO_URI" = "null" ]; then
    echo "❌ Could not resolve MONGO_URI."
    echo "   Either run from a directory containing .env, or export it first:"
    echo "     export MONGO_URI='mongodb+srv://...'"
    exit 1
fi
echo "✅ MONGO_URI resolved"

if [ "$SKIP_BUILD" = true ]; then
    echo ""
    echo "⏭  Skipping build (--skip-build) — reusing $IMAGE"
else
    echo ""
    echo "🔨 Building migration image..."
    # No --region: Cloud Build isn't offered in every Cloud Run region (me-central1
    # among them), and the build's location is irrelevant because gcr.io is
    # multi-regional.
    gcloud builds submit \
        --config=cloudbuild.migration.yaml \
        --project="$PROJECT_ID"
fi

# create-or-update: `gcloud run jobs create` fails if the job already exists.
deploy_job() {
    local name="$1" cpu="$2" mem="$3" heap="$4" script="$5"
    shift 5
    # Iterate "$@" directly rather than copying into an array: macOS ships bash 3.2,
    # where "${arr[@]}" on an empty array trips `set -u`.

    local verb="create"
    if gcloud run jobs describe "$name" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
        verb="update"
    fi

    echo ""
    echo "🚀 ${verb}: $name  (cpu=$cpu mem=$mem heap=${heap}MB)"

    # --resume is always passed: on a first run there is no checkpoint so it starts from
    # the beginning, and on a Cloud Run retry it picks up where the previous task died.
    # The checkpoint lives in Mongo (utils/migrationState.js), not the container disk.
    local args="--max-old-space-size=${heap},${script},--resume"
    for a in "$@"; do args="${args},${a}"; done

    gcloud run jobs "$verb" "$name" \
        --image="$IMAGE" \
        --region="$REGION" \
        --project="$PROJECT_ID" \
        --command=node \
        --args="$args" \
        --set-env-vars="MONGO_URI=${MONGO_URI}" \
        --cpu="$cpu" \
        --memory="$mem" \
        --task-timeout=86400 \
        --parallelism=1 \
        --tasks=1 \
        --max-retries=3
}

# Streams in batches, so memory is small. Network-bound.
deploy_job "$MIGRATE_JOB" 2 2Gi 1536 scripts/migrateEmbeddingsToBinaryVector.js

# Holds a 20000 x 1536 float64 matrix (~245 MB) plus PCA working copies while training,
# hence the larger heap and memory.
deploy_job "$REPROJECT_JOB" 4 8Gi 6144 scripts/retrainAndReprojectPCA.js

cat <<EOF

✅ Jobs registered. Nothing has run yet.

────────────────────────────────────────────────────────────────────────
RUN THEM IN THIS ORDER — step 1 makes step 2 roughly 3x cheaper, because
step 2 reads every article's 1536-D embedding (~7.7 GB as arrays vs
~2.3 GB as binary float32).
────────────────────────────────────────────────────────────────────────

  # Step 1 — storage format migration (safe, byte-exact, idempotent)
  gcloud run jobs execute $MIGRATE_JOB --region $REGION --project $PROJECT_ID --wait

  # Step 2 — retrain PCA basis + re-project articles, reels and users
  gcloud run jobs execute $REPROJECT_JOB --region $REGION --project $PROJECT_ID --wait

  # Follow logs while a job runs (or drop --wait above and tail these):
  gcloud beta run jobs logs tail $MIGRATE_JOB --region $REGION --project $PROJECT_ID

  # Step 3 — REQUIRED. Both services cache the PCA basis in memory per process
  # and keep serving the old one until they restart:
  #   backend:     ./deploy.sh
  #   scraper-job: cd ../scraper-job && ./deploy.sh

Dry runs (read-only, no writes) if you want to see counts first:
  gcloud run jobs execute $MIGRATE_JOB --region $REGION --project $PROJECT_ID \\
      --args="--max-old-space-size=1536,scripts/migrateEmbeddingsToBinaryVector.js,--dry-run" --wait

EOF
