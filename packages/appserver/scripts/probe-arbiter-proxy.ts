/**
 * Probe: which arbiter proxy route will serve the appserver's provisioning
 * call — and, when one refuses, *why*.
 *
 * `provision.ts` step 3 proxies a `com.atproto.repo.putRecord` of the new
 * space's `space.roomy.service/self` record through the arbiter. There are two
 * routes to the arbiter's policy pipeline, and they apply different gates:
 *
 *   - `space.roomy.authComplete.arbiter.proxy` (scoped) — the arbiter first
 *     requires the scope prefix (`space.roomy.authComplete`) to be in the
 *     account's `town.muni.arbiter.config/self` `trustedScopes`, then evaluates
 *     the *permission-set lexicon's* embedded Rego over the inner request core.
 *     A denial here is `403 {"error":"Forbidden","message":"request denied by
 *     scope policy"}` and happens before the community pipeline — and before
 *     anything is written.
 *   - `town.muni.arbiter.proxy` (built-in) — no scope gate. Goes straight to
 *     the community pipeline, where the installed default policy admits the
 *     account's designated recovery admin (the appserver) and proxies as the
 *     steward.
 *
 * This probe sends the same inner request over both routes and prints status +
 * body. It is **read-only by construction**: the inner call is
 * `com.atproto.repo.getRecord`, and the service record is read, never written —
 * so neither an allow nor a deny can mutate the space.
 *
 * Usage:
 *   ATPROTO_IDENTIFIER=<handle> ATPROTO_APP_PASSWORD=<pw> \
 *     bun run scripts/probe-arbiter-proxy.ts --space <space-did>
 *
 * Environment:
 *   ARBITER_URL / ARBITER_DID — override discovery (else read from the space's
 *                              `town.muni.arbiter.service/self` record)
 *   ATPROTO_PDS               — caller's PDS (default https://bsky.social)
 *   PLC_DIRECTORY_URL         — default https://plc.directory
 */

import { AtpAgent } from "@atproto/api";

// ─── Args / env ──────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const spaceDid = arg("space");
if (!spaceDid) {
  console.error("required: --space <space-did>");
  process.exit(2);
}

const plcUrl = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

const SCOPED_ROUTE = "space.roomy.authComplete.arbiter.proxy";
const BUILTIN_ROUTE = "town.muni.arbiter.proxy";

/** `did:web:arbiter.muni.town` → `https://arbiter.muni.town` (port-aware). */
function urlFromDid(did: string): string {
  if (!did.startsWith("did:web:")) throw new Error(`not a did:web: ${did}`);
  const host = did
    .slice("did:web:".length)
    .split(":")
    .map(decodeURIComponent)
    .join(":");
  return `https://${host}`;
}

// ─── Discover the space's arbiter ────────────────────────────────────────

async function pdsOf(did: string): Promise<string> {
  const res = await fetch(`${plcUrl}/${encodeURIComponent(did)}`);
  if (!res.ok) throw new Error(`PLC lookup for ${did} failed (${res.status})`);
  const doc: unknown = await res.json();
  if (!doc || typeof doc !== "object" || !("service" in doc)) {
    throw new Error(`${did} DID document has no services`);
  }
  const services = doc.service;
  if (!Array.isArray(services))
    throw new Error(`${did} DID document services are malformed`);
  for (const entry of services) {
    if (
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      "serviceEndpoint" in entry &&
      entry.id === "#atproto_pds" &&
      typeof entry.serviceEndpoint === "string"
    ) {
      return entry.serviceEndpoint;
    }
  }
  throw new Error(`${did} has no #atproto_pds`);
}

const spacePds = await pdsOf(spaceDid);

const serviceRes = await fetch(
  `${spacePds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(spaceDid)}` +
    `&collection=town.muni.arbiter.service&rkey=self`,
);
if (!serviceRes.ok) {
  throw new Error(
    `no town.muni.arbiter.service/self on ${spaceDid} (${serviceRes.status})`,
  );
}
const serviceJson: unknown = await serviceRes.json();
let discoveredArbiterDid: string | undefined;
if (
  serviceJson &&
  typeof serviceJson === "object" &&
  "value" in serviceJson &&
  serviceJson.value &&
  typeof serviceJson.value === "object" &&
  "did" in serviceJson.value &&
  typeof serviceJson.value.did === "string"
) {
  discoveredArbiterDid = serviceJson.value.did;
}

const discovered = process.env.ARBITER_DID ?? discoveredArbiterDid;
if (!discovered)
  throw new Error(`${spaceDid} has no arbiter DID in its service record`);
// Narrowed above; a `const` keeps the narrowing inside `probe`'s closure.
const arbiterDid: string = discovered;
const arbiterUrl = process.env.ARBITER_URL ?? urlFromDid(arbiterDid);

// ─── Authenticate a caller ───────────────────────────────────────────────

const identifier = process.env.ATPROTO_IDENTIFIER;
const password = process.env.ATPROTO_APP_PASSWORD;
if (!identifier || !password) {
  console.error("required: ATPROTO_IDENTIFIER + ATPROTO_APP_PASSWORD");
  process.exit(2);
}

// The caller's PDS is not necessarily bsky.social: resolve the identifier's
// DID, then its `#atproto_pds` (mirrors `packages/cli/src/auth.ts`).
async function didOf(identifier: string): Promise<string> {
  if (identifier.startsWith("did:")) return identifier;
  const res = await fetch(
    `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
  );
  if (!res.ok)
    throw new Error(`could not resolve handle ${identifier} (${res.status})`);
  const json: unknown = await res.json();
  if (
    json &&
    typeof json === "object" &&
    "did" in json &&
    typeof json.did === "string"
  ) {
    return json.did;
  }
  throw new Error(`handle ${identifier} did not resolve to a DID`);
}

const agent = new AtpAgent({
  service: process.env.ATPROTO_PDS ?? (await pdsOf(await didOf(identifier))),
});
await agent.login({ identifier, password });

// The inner request mirrors provision.ts step 3's envelope shape (same target,
// same inner NSID family) but reads instead of writes, so it is safe to send:
// a deny cannot write, and an allow only reads.
const envelope = {
  arbiterDid: spaceDid,
  target: `${spaceDid}#atproto_pds`,
  method: "GET",
  nsid: "com.atproto.repo.getRecord",
  parameters: {
    repo: spaceDid,
    collection: "space.roomy.service",
    rkey: "self",
  },
};

async function probe(route: string): Promise<void> {
  const { data } = await agent.com.atproto.server.getServiceAuth({
    aud: arbiterDid,
    lxm: route,
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const res = await fetch(`${arbiterUrl}/xrpc/${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${data.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(envelope),
  });
  const text = await res.text();
  console.log(`\n${route}`);
  console.log(`  ${res.status} ${text.slice(0, 400)}`);
}

console.log(`caller  : ${agent.did}`);
console.log(`space   : ${spaceDid}`);
console.log(`arbiter : ${arbiterDid} @ ${arbiterUrl}`);
console.log(`inner   : GET com.atproto.repo.getRecord (read-only)`);

await probe(SCOPED_ROUTE);
await probe(BUILTIN_ROUTE);
