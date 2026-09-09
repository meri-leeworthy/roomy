/**
 * Generate the OAuth scope string for the docs site's OAuth client metadata.
 *
 * The scope is derived from the endpoint registry so it can't drift: every
 * registered XRPC method gets an `rpc:<nsid>?aud=*` scope, plus the base
 * `atproto` scope and the PDS RPCs the site needs (profile lookup, service
 * auth). Admin endpoints are included — the appserver still enforces its own
 * admin allowlist, so non-admins simply get 403s.
 *
 * Usage: npx tsx scripts/gen-oauth-scope.ts
 * Output: a single space-separated scope string on stdout.
 */
import { endpoints } from "../src/lib/endpoints/registry.js";

const appserverDid = process.env.VITE_APPSERVER_DID ?? "did:web:appserver.roomy.chat";

const scopes = new Set<string>([
  "atproto",
  "rpc:app.bsky.actor.getProfile?aud=*",
  `rpc:com.atproto.server.getServiceAuth?aud=${appserverDid}`,
]);

for (const group of endpoints) {
  for (const ep of group.items) {
    scopes.add(`rpc:${ep.nsid}?aud=*`);
  }
}

process.stdout.write([...scopes].join(" ") + "\n");
