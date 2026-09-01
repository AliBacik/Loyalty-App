#!/usr/bin/env bash
# Builds the image and deploys the Eternate Loyalty service to Cloud Run.
#
# Config is read from an env file (default .env.local) and passed to Cloud Run
# as plain environment variables, matching how the other services in this
# project are configured. Values therefore live in the service definition in
# clear text -- see GCLOUD-DEPLOY.md for the trade-off and the Secret Manager
# migration path.
set -euo pipefail

PROJECT="${PROJECT:-renart-storefronts}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-eternate-loyalty-app}"
ENV_FILE="${ENV_FILE:-.env.local}"
SHOP="${SHOP:-riverdiamond.myshopify.com}"
# Per-store override prefix inside $ENV_FILE, e.g. KEY_PREFIX=VIANISA_ makes
# VIANISA_SHOPIFY_API_KEY supply SHOPIFY_API_KEY. Empty means the plain keys.
KEY_PREFIX="${KEY_PREFIX:-}"

[ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }

# SHOPIFY_APP_URL must equal the service's own public URL, and shopifyApp()
# refuses to boot with an empty appUrl, so it has to be right on the first
# deploy. Cloud Run serves two hostnames per service; use the project-number
# form consistently -- it matches the other services here and is what is
# registered with Shopify and Zoho. (gcloud's status.url reports the older
# <hash>-uc form, so reading it back would flip the value every deploy.)
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
APP_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

# The values include JSON blobs and comma-separated lists, so the env file is
# built by a small Python helper instead of shell quoting.
ENV_YAML="$(mktemp)"
trap 'rm -f "$ENV_YAML"' EXIT
python "$(dirname "$0")/env-to-yaml.py" "$ENV_FILE" "$SHOP" "$APP_URL" "$KEY_PREFIX" > "$ENV_YAML"

echo "Deploying ${SERVICE} to ${REGION} (${PROJECT})..."

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --timeout=300 \
  --concurrency=80 \
  --min-instances=1 \
  --max-instances=10 \
  --env-vars-file="$ENV_YAML"

echo
echo "Deployed: ${APP_URL}"
echo "Next: point shopify.app.toml (application_url + redirect_urls) at this URL,"
echo "      run 'shopify app deploy', then reinstall the app on ${SHOP}."
