#!/bin/bash

# Netlify build entry point (see netlify.toml). Runs from the dispatched
# `Netlify Deploy` workflow (.github/workflows/netlify.yml), which deploys with
# `netlify deploy --build`; it builds the app-lite frontend and wires it to the
# staging appserver.
set -euo pipefail

cd "$(dirname "$0")/.."

# ── The deployment's own URL ─────────────────────────────────────────────
# The OAuth client metadata is served by the deployment itself: its client_id
# is `<this deployment>/oauth-client-metadata.json` and its redirect URI is
# `<this deployment>/`. Both must name the origin the deploy is served from,
# which only Netlify knows once the deploy exists — so this build reads the
# URL of the deploy it is building.
#
# DEPLOY_URL names that deploy: `netlify deploy --build` creates the deploy,
# then builds with its URL in the environment. URL would be the site's primary
# URL instead, which is a different origin for a draft deploy — an OAuth
# client_id there would name a deployment this build is not.
#
# BUILD_ID is deliberately cleared. It is otherwise inherited from the CLI's
# own environment, where it is the constant '0'; build-prod.sh falls back to
# the checkout's commit, which names the revision this bundle actually
# contains.
DEPLOY_HOST="${DEPLOY_URL:?Netlify provided no DEPLOY_URL (build outside 'netlify deploy --build'?)}"
export OAUTH_HOST="$DEPLOY_HOST"
unset BUILD_ID

# This build IS the web deployment, served from its own origin — so shareable
# links (invites) must root here rather than at the production default, or a
# preview invite would point at the production app. PUBLIC_WEB_ORIGIN is the
# marker the bundle compares against the document origin (see
# packages/app-lite/src/lib/share-url.ts); VITE_PUBLIC_WEB_ORIGIN is the
# fallback origin itself.
export PUBLIC_WEB_ORIGIN="$DEPLOY_HOST"
export VITE_PUBLIC_WEB_ORIGIN="$DEPLOY_HOST"

# ── Staging appserver ────────────────────────────────────────────────────
# A single WebSocket-origin override points BOTH the sync connection and the
# XRPC HTTP client at the appserver (config.ts derives the http(s) origin from
# it). The DID is the service-auth audience every XRPC call is scoped to, so
# the two belong to the same environment and are set together. Overridable
# from the Netlify UI for a deployment that should target something else.
export VITE_APPSERVER_WS_ORIGIN="${VITE_APPSERVER_WS_ORIGIN:-wss://api-staging.roomy.space}"
export VITE_APPSERVER_DID="${VITE_APPSERVER_DID:-did:web:api-staging.roomy.space}"

echo "Netlify build: $DEPLOY_HOST → $VITE_APPSERVER_WS_ORIGIN ($VITE_APPSERVER_DID)"

# app-lite imports @roomy-space/sdk from its built dist, not its src.
pnpm turbo run build-lib

# Vite build + OAuth client metadata + build-identity check, publishing
# packages/app-lite/build (the path netlify.toml publishes).
bash packages/app-lite/scripts/build-prod.sh
