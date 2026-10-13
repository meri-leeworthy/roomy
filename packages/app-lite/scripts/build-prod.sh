#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Build identity ───────────────────────────────────────────────────────
# The served bundle must be able to name its commit (it is exposed as
# /build.json and inlined as __BUILD_ID__; see src/lib/build-id.ts). In the
# Docker build `Dockerfile.app-lite` already sets BUILD_ID from
# RAILWAY_GIT_COMMIT_SHA, so this only fills the gap for builds run outside
# that image — a local `scripts/build-prod.sh`, where nothing supplies it yet.
# First 8 chars, matching the Dockerfile's expansion and the appserver /
# discord-bridge id format, so the three are comparable in one query.
if [ -z "${BUILD_ID:-}" ] && [ -n "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then
  export BUILD_ID="${RAILWAY_GIT_COMMIT_SHA:0:8}"
fi
if [ -z "${BUILD_ID:-}" ] && command -v git >/dev/null 2>&1; then
  BUILD_ID="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$BUILD_ID" ]; then
    export BUILD_ID="${BUILD_ID:0:8}"
    echo "BUILD_ID not supplied; using local git HEAD ${BUILD_ID} ($(git branch --show-current 2>/dev/null || echo detached))"
  fi
fi
if [ -z "${BUILD_ID:-}" ]; then
  # OPERATIONAL, not cosmetic: a deploy built without git metadata cannot be
  # named afterwards. Report it loudly rather than serving a bundle whose
  # commit no one can recover.
  echo "WARNING: BUILD_ID is unset and no git commit could be resolved;" >&2
  echo "         /build.json will report commit \"unknown\" for this build." >&2
fi

# The web build needs its client_id URL baked in — used by BOTH OAuth modes
# (legacy mode fetches + parses it; HappyView mode passes it through).
target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://app-lite.roomy.chat)"}
export VITE_OAUTH_CLIENT_ID="${target_url}/oauth-client-metadata.json"

# ── Apple App Site Association: preflight ─────────────────────────────────
# Everything the association file needs is knowable before the frontend build
# (see the generation step below for what the file is): the claim in
# src-tauri/tauri.conf.json, and APPLE_DEVELOPMENT_TEAM for the appIDs entry.
# Resolving them here means a deployment that cannot produce the file fails in
# seconds rather than after `pnpm build`.
node --experimental-strip-types scripts/gen-aasa.mjs \
  --mode preflight --out build-staging --origin "$target_url"

pnpm build

# ── Apple App Site Association ────────────────────────────────────────────
# The served half of the `associated-domains` entitlement the iOS build carries
# (src-tauri/tauri.conf.json declares `applinks:roomy.space`; the deep-link
# plugin's build script writes it into the app's entitlements). Without the file
# Apple fetches from the domain, that entitlement is a signed claim nothing can
# verify — Apple's CDN answers 404 and every shared link opens the browser.
#
# Generated, not committed: the `appIDs` entry is `<Team ID>.<Bundle ID>`, and
# the Team ID is an Apple account property. gen-aasa.mjs reads the team id from
# APPLE_DEVELOPMENT_TEAM and fails the build when it is unset or malformed,
# rather than shipping a file whose appIDs cannot match the app (same contract
# as the OAuth-metadata and build-identity verifications below).
#
# $target_url is the origin this build is served from — the same value that
# decides the OAuth client_id. It also decides whether this deployment is the
# host the app claims: a build for any other origin, staging included, is left
# without an association file, which the verification below asserts.
echo "Generating Apple App Site Association..."
node --experimental-strip-types scripts/gen-aasa.mjs \
  --out build-staging --origin "$target_url"

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  SCOPE STRING                                                              ║
# ║  The scope ceiling is defined ONCE in src/lib/scopes.ts                     ║
# ║  (FULL_SCOPE_CEILING). This script derives SCOPE from it. The only         ║
# ║  env-dependent tokens (stream-handle NSID, appserver DID) are read by      ║
# ║  scopes.ts itself from VITE_STREAM_HANDLE_NSID / VITE_APPSERVER_DID — so    ║
# ║  the metadata always carries the environment's values, byte-identical to   ║
# ║  what config.ts's OAUTH_SCOPE would request.                               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

SCOPE="$(
  node --experimental-strip-types -e 'import("./src/lib/scopes.ts").then((m) => process.stdout.write(m.FULL_SCOPE_CEILING))'
)"

# ── Confidential client (session duration) ───────────────────────────────
# When HAPPYVIEW_JWKS_URI is set (the JWKS HappyView publishes for this
# client's delegated signing key — provision it with
# POST /admin/api-clients/{id}/auth-key), the metadata declares
# `private_key_jwt`: the PDS then treats Roomy as a confidential client and
# grants ~2-year refresh tokens instead of ~2-week public ones. HappyView
# holds the signing key and mints the PAR/token-exchange client assertions
# on demand. Unset → the client stays public (PKCE only).
if [ -n "${HAPPYVIEW_JWKS_URI:-}" ]; then
  # private_key_jwt REQUIRES token_endpoint_auth_signing_alg on the atproto PDS:
  # without it the AS rejects the metadata outright (invalid_client_metadata:
  # "Missing token_endpoint_auth_signing_alg client metadata"). HappyView
  # mints ES256 client assertions from the provisioned key (the only alg
  # atproto allows for client auth).
  auth_method_fields=$(
    cat <<EOF
  "token_endpoint_auth_method": "private_key_jwt",
  "token_endpoint_auth_signing_alg": "ES256",
  "jwks_uri": "${HAPPYVIEW_JWKS_URI}",
EOF
  )
else
  auth_method_fields='  "token_endpoint_auth_method": "none",'
fi

# Build the OAuth client metadata JSON
oauth_shared=$(
  cat <<EOF
  "client_name": "Roomy Lite",
  "client_uri": "$target_url",
  "logo_uri": "$target_url/favicon.png",
  "scope": "${SCOPE}",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "dpop_bound_access_tokens": true
EOF
)

oauth_web_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-metadata.json",
  "redirect_uris": ["$target_url/"],
  "application_type": "web",
  ${auth_method_fields}
  ${oauth_shared}
}
EOF
)

# The Tauri desktop client keeps the tested public direct-PDS flow — the native
# metadata stays public ("token_endpoint_auth_method": "none") regardless of
# HAPPYVIEW_JWKS_URI: private_key_jwt would break desktop login until the
# desktop HappyView flow ships.
oauth_native_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-native.json",
  "redirect_uris": ["space.roomy:/","$target_url/"],
  "application_type": "native",
  "token_endpoint_auth_method": "none",
  ${oauth_shared}
}
EOF
)

# Write first so the verification below can read the actual artifact
echo "$oauth_web_config" > build-staging/oauth-client-metadata.json
echo "$oauth_native_config" > build-staging/oauth-client-native.json

echo "Scope: ${SCOPE:0:120}..."

# ── Build-time verification ──────────────────────────────────────────────
# Ensure every tier's scopes are a subset of the metadata ceiling, and the
# shipped metadata's scope is exactly the ceiling. The ceiling (and the tiers)
# are now the single source of truth in src/lib/scopes.ts, so this catches any
# drift where a tier gained a scope the metadata no longer declares (which
# would make the PDS reject it with invalid_scope). It reads the already-written
# oauth-client-metadata.json so we test the actual deployed artifact.
node --experimental-strip-types -e "
import { readFileSync } from 'node:fs';
import('./src/lib/scopes.ts').then((m) => {
  const meta = JSON.parse(readFileSync('build-staging/oauth-client-metadata.json', 'utf-8'));
  const scope = meta.scope || '';
  let hasErrors = false;

  const ceilingScopes = m.parseScopes(m.FULL_SCOPE_CEILING);
  for (const [tier, tierScope] of Object.entries(m.SCOPE_SETS)) {
    for (const s of m.parseScopes(tierScope)) {
      if (!ceilingScopes.has(s)) {
        console.log('MISSING SCOPE (tier ' + tier + ' not in ceiling): ' + s);
        hasErrors = true;
      }
    }
  }

  // The shipped metadata scope must be exactly the ceiling (byte-identical).
  if (scope !== m.FULL_SCOPE_CEILING) {
    console.log('MISMATCH: shipped metadata scope != FULL_SCOPE_CEILING');
    hasErrors = true;
  }

  if (hasErrors) process.exit(1);
  console.log('All tier scopes present in ceiling, metadata scope == ceiling — verification passed');
}).catch((e) => { console.error(e); process.exit(1); });
"
if [ $? -ne 0 ]; then
  echo "ERROR: A tier scope is missing from the metadata ceiling, or the" >&2
  echo "shipped scope drifts from src/lib/scopes.ts FULL_SCOPE_CEILING." >&2
  echo "Fix the tier/ceiling definitions in src/lib/scopes.ts." >&2
  exit 1
fi

# ── Build-identity verification ─────────────────────────────────────────
# The service is only nameable if the artifact says which commit it is. A
# deploy whose bundle carries no id cannot be tied to a revision afterwards,
# so fail the build here rather than publish an unnameable bundle (same
# contract as the OAuth-scope verification above: test the artifact that ships,
# not the intention). `build.json` is a prerendered route, so its absence means
# the route did not make it into the output at all.
if [ ! -f build-staging/build.json ]; then
  echo "ERROR: build-staging/build.json is missing — the deployed bundle would" >&2
  echo "       carry no build identity. Is src/routes/build.json/+server.ts present?" >&2
  exit 1
fi
built_commit="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("build-staging/build.json","utf8")).commit)')"
if [ -z "$built_commit" ]; then
  echo "ERROR: build-staging/build.json has an empty commit — present but" >&2
  echo "       meaningless, indistinguishable from a real id downstream." >&2
  exit 1
fi
if [ "$built_commit" = "unknown" ]; then
  # Not fatal: a rebuild of already-built source, or a build in an environment
  # with no git metadata, is legitimate. It must still be visible in the log.
  echo "WARNING: this build reports commit \"unknown\" — the bundle cannot name" >&2
  echo "         its commit, so a later deploy-revision audit cannot either." >&2
else
  echo "Build identity: commit ${built_commit} (served as /build.json)"
fi

# ── App Site Association verification ────────────────────────────────────
# Read the file that ships rather than trusting the generation above: a
# deployment served from the app's claimed host must carry an association file
# naming `<Team ID>.<Bundle ID>` over every declared path prefix, and one served
# from any other origin must carry none. Covers the whole chain from
# `src-tauri/tauri.conf.json` (the claim, and the source of the Android intent
# filter) to the bytes on disk, so a renamed host, a dropped pathPrefix, or a
# build with no APPLE_DEVELOPMENT_TEAM cannot ship silently.
node --experimental-strip-types scripts/gen-aasa.mjs \
  --verify --out build-staging --origin "$target_url"

# ── Social-unfurl verification ──────────────────────────────────────────
# Every route is `ssr = false`, so the served HTML is `app.html` and the
# per-page `<svelte:head>` output (SeoMeta) is only produced once the client
# bundle runs. Crawlers and chat embedders (Twitter/X, Discord, Slack,
# iMessage) fetch the raw HTML and never run it, so an og:image present only
# at runtime is invisible — the link unfurls with no image. The tags must
# therefore exist statically in app.html, which the adapter copies verbatim
# into index.html. Assert the shipped artifact carries them (same contract as
# the verifications above: test what deploys, not the intention) so a refactor
# that moves them back into a component cannot ship unfurlless links silently.
if [ ! -f build-staging/index.html ]; then
  echo "ERROR: build-staging/index.html is missing — nothing to serve." >&2
  exit 1
fi
# Match the actual tags, not the words: the explanatory comment in app.html
# names og:image, so a bare substring grep would pass after the tag itself was
# deleted. Require `<meta property="og:image" ...>` (and the absolute URL) so
# the check can only pass on a real, unfurlable tag.
for tag in \
  '<meta property="og:image" content="https://roomy.space/roomy-og.png"' \
  '<meta property="og:title"' \
  '<meta name="twitter:card" content="summary_large_image"' \
  '<meta name="twitter:image"'; do
  if ! grep -qF "$tag" build-staging/index.html; then
    echo "ERROR: '${tag}' is absent from the built index.html." >&2
    echo "       Routes are ssr=false, so this shell is what crawlers see." >&2
    echo "       Keep the static og/* tags in src/app.html — a tag emitted" >&2
    echo "       only by <svelte:head> never reaches the served HTML." >&2
    exit 1
  fi
done
echo "Social unfurl verified: static og/* + twitter:* present in index.html"
echo "Done! OAuth metadata written to build-staging/oauth-client-metadata.json"
echo "Done! App Site Association verified at build-staging/.well-known/apple-app-site-association"

# ── Publish atomically ──────────────────────────────────────────────────
# The static server serves `build/` live, so never let a partial build leak
# in. Swap staging into place in one shot; the previous build is kept briefly
# as build.old and dropped after. A failed `pnpm build` above leaves build/
# untouched (staging is only moved after everything succeeded).
rm -rf build.old
if [ -e build ]; then mv build build.old; fi
mv build-staging build
rm -rf build.old
echo "Published build/ atomically (old copy at build.old until removed)"
