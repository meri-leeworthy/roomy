#!/usr/bin/env node
/**
 * OAuth scope drift check (CI-runnable).
 *
 * Verifies that every RPC scope declared in src/lib/config.ts
 * (APPSERVER_RPCS, plus quoted rpc:/repo: entries in OAUTH_SCOPE) is
 * present in the SCOPE assembly in scripts/build-prod.sh. This is the
 * same drift the build-time verification in build-prod.sh catches — but
 * against the assembly, so it runs without a build or OAuth metadata.
 *
 * Run: node scripts/check-oauth-scopes.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configSrc = readFileSync(join(root, "src/lib/config.ts"), "utf-8");
const buildScript = readFileSync(join(root, "scripts/build-prod.sh"), "utf-8");

// Assemble the scope string exactly as build-prod.sh does: every
// `SCOPE+="..."` line, concatenated. Template literals (${...}) are kept
// verbatim — the checks below only need static prefixes.
const scope = [...buildScript.matchAll(/SCOPE\+=("[^"]*")/g)]
  .map((m) => JSON.parse(m[1]))
  .join(" ");

let hasErrors = false;

// Check APPSERVER_RPCS
const rpcMatch = configSrc.match(/const APPSERVER_RPCS\s*=\s*\[([\s\S]*?)\]/);
if (rpcMatch) {
  const items = rpcMatch[1].split(/['"]/).filter((_, i) => i % 2 === 1);
  const missing = items.filter((nsid) => !scope.includes("rpc:" + nsid));
  if (missing.length) {
    console.log("MISSING RPC SCOPES (from APPSERVER_RPCS):");
    missing.forEach((n) => console.log("  " + n));
    hasErrors = true;
  }
}

// Check OAUTH_SCOPE for rpc: and repo: entries (quoted strings only;
// template-literal entries are checked separately below).
const scopeMatch = configSrc.match(/export const OAUTH_SCOPE\s*=\s*\[([\s\S]*?)\]/);
if (scopeMatch) {
  const items = scopeMatch[1].split(/['"]/).filter((_, i) => i % 2 === 1);
  const missingScopes = items
    .filter((s) => s.startsWith("repo:") || s.startsWith("rpc:"))
    .filter((s) => !scope.includes(s));
  if (missingScopes.length) {
    console.log("MISSING SCOPES (from OAUTH_SCOPE):");
    missingScopes.forEach((n) => console.log("  " + n));
    hasErrors = true;
  }
}

// getServiceAuth scope (template literal in config.ts with a dynamic aud=)
// must be present by its static prefix.
if (!scope.includes("rpc:com.atproto.server.getServiceAuth?aud=")) {
  console.log("MISSING SCOPES (from OAUTH_SCOPE):");
  console.log("  rpc:com.atproto.server.getServiceAuth?aud=...");
  hasErrors = true;
}

if (hasErrors) {
  console.error("ERROR: Scopes from config.ts are missing from the OAuth scope.");
  console.error("Add them to the SCOPE assembly in build-prod.sh");
  process.exit(1);
}

console.log("All appserver RPC scopes and repo scopes present — verification passed");
