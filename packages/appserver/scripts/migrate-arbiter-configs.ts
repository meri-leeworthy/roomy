/**
 * One-time migration script: bootstrap `town.muni.arbiter.config/self`
 * records on every Roomy space account stewarded by the arbiter server.
 *
 * The arbiter's policy-resolution switch (trusted scopes + ordered policy
 * layers read from a `town.muni.arbiter.config` record) left previously
 * managed accounts without a config record, so each arbiter is offboarded
 * (fail-closed). This script applies a reference config record to every
 * managed account via the recovery-admin-only `town.muni.arbiter.resetConfig`
 * hatch, authenticated with a self-signed serviceAuth JWT — the same token
 * shape the appserver mints for all arbiter calls (see
 * `src/auth/serviceAuth.ts`), signed with the appserver's private key.
 *
 * Self-contained — no appserver runtime modules are imported. For each space
 * DID it:
 *   1. resolves the DID document → `#atproto_pds` endpoint
 *   2. reads `town.muni.arbiter.service/self` from the space's repo (public)
 *      — anything not pointing at ARBITER_DID is skipped (legacy did:plc
 *      spaces, or accounts stewarded by a different arbiter)
 *   3. reads `town.muni.arbiter.config/self` (public):
 *        - matches the reference config → skip (idempotent re-run)
 *        - differs                      → skip + flag (needs --force)
 *        - missing                      → resetConfig via the arbiter
 *   4. re-reads the record to verify the write landed
 *
 * Safety:
 *   - DRY-RUN by default; pass `--apply` to mutate.
 *   - The signing key is verified against the appserver DID document's
 *     Multikey before anything happens — a wrong key aborts the run.
 *   - The reference config's policyLayers are fetched and shape-checked
 *     before any resetConfig call (a broken layer URI would fail-close every
 *     reset arbiter).
 *   - The arbiter is the final authority: an `ErrPermissionDenied` answer is
 *     harmless (no mutation) and is flagged rather than retried blindly.
 *   - Per-DID outcomes are appended to a JSONL manifest for audit/resume.
 *   - Transient failures (network, 5xx, 429, and the arbiter's issuer-DID
 *     resolution failures) are retried with backoff.
 *   - `--single` stops after the first real action (success or failure);
 *     skips don't stop the run.
 *
 * Usage:
 *   bun run scripts/migrate-arbiter-configs.ts [--apply] [--force]
 *       [--single] [--only <did>]... [--dids-file <path>] [--config <at-uri>]
 *       [--policy-layer <at-uri>]... [--results <path>] [--key <hex>]
 *       [--key-file <path>] [--skip-policy-check]
 *
 * Environment variables:
 *   ARBITER_URL            — arbiter server origin (required)
 *   ARBITER_DID            — arbiter server DID, the serviceAuth `aud` (required)
 *   APPSERVER_DID          — appserver DID (default: did:web:api.roomy.space)
 *   APPSERVER_SIGNING_KEY  — appserver signing key, 32-byte hex. Required
 *                            unless --key/--key-file is passed. The
 *                            production value lives in the appserver
 *                            deployment env, or in
 *                            DATA_DIR/appserver-signing-key.hex on its
 *                            persistent volume (Railway: /data).
 *   EVENTS_DB_PATH         — events DB (default: data/roomy-events.sqlite);
 *                            `select did from dids` enumerates the spaces
 *   REFERENCE_CONFIG       — at:// URI of the reference config record
 *                            (default:
 *                            at://did:plc:2qgcei4augq7n4ldxsdrcplx/town.muni.arbiter.config/self)
 *   PLC_DIRECTORY_URL      — PLC directory (default: https://plc.directory)
 *   DATA_DIR               — used to locate the signing key file when
 *                            neither --key nor APPSERVER_SIGNING_KEY is set
 *                            (default: data)
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";

// ─── Constants ───────────────────────────────────────────────────────────

const SERVICE_COLLECTION = "town.muni.arbiter.service";
const CONFIG_COLLECTION = "town.muni.arbiter.config";
const RESET_CONFIG_NSID = "town.muni.arbiter.resetConfig";

/** serviceAuth token lifetime in seconds (mirrors the appserver: 60s). */
const TOKEN_TTL_SEC = 60;

/** Hard timeout for a single outbound HTTP request. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Retry schedule for transient failures (initial attempt + these pauses). */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** Spaces processed per batch, mirroring migrate-spaces-to-pds.ts. */
const BATCH_SIZE = 10;

const DEFAULT_APPSERVER_DID = "did:web:api.roomy.space";
const DEFAULT_REFERENCE_CONFIG =
  "at://did:plc:2qgcei4augq7n4ldxsdrcplx/town.muni.arbiter.config/self";
/**
 * Default policy layers for the config applied to every account — Roomy's
 * own default policy record. Mirrors `REFERENCE_ARBITER_CONFIG` in
 * `src/arbiter/provision.ts` (keep in sync). Trusted scopes always come from
 * the reference config record; `--policy-layer` overrides these.
 */
const DEFAULT_POLICY_LAYERS = [
  "at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default",
];

// ─── Options ─────────────────────────────────────────────────────────────

export interface MigrationOptions {
  /** Mutate. Without this the run is a dry-run. */
  apply: boolean;
  /** Overwrite an existing config record that differs from the reference. */
  force: boolean;
  /** Only process these DIDs (bypasses events-DB enumeration). */
  only: string[];
  /** Newline-separated DID list instead of the events DB. */
  didsFile: string | null;
  /** Stop after the first real action (success or failure); skips continue. */
  single: boolean;
  /** at:// URI of the reference config record. */
  configUri: string;
  /** JSONL outcome manifest path. */
  resultsPath: string;
  /** Skip fetch + shape validation of the reference policyLayers. */
  skipPolicyCheck: boolean;
  /** Replace the reference record's policyLayers (repeatable, ordered). */
  policyLayersOverride: string[];
  /** Signing key: 32-byte private key hex. */
  signingKeyHex: string;
  /** Where the signing key was resolved from (for the log). */
  keySource: string;

  // Endpoints
  arbiterUrl: string;
  arbiterDid: string;
  appserverDid: string;
  plcUrl: string;
  eventsDbPath: string;
}

export function parseArgs(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): MigrationOptions {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const values = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === name) {
        const v = argv[i + 1];
        if (v) {
          out.push(v);
          i++;
        }
      }
    }
    return out;
  };

  const arbiterUrl = env.ARBITER_URL;
  const arbiterDid = env.ARBITER_DID;
  if (!arbiterUrl) {
    console.error("ARBITER_URL is required (the new arbiter server's origin)");
    process.exit(1);
  }
  if (!arbiterDid) {
    console.error("ARBITER_DID is required (the arbiter server's own DID)");
    process.exit(1);
  }

  const appserverDid = env.APPSERVER_DID ?? DEFAULT_APPSERVER_DID;

  // Signing key precedence: --key > --key-file > APPSERVER_SIGNING_KEY >
  // DATA_DIR/appserver-signing-key.hex (mirrors loadAppserverSigningKey).
  let signingKeyHex: string | undefined;
  let keySource: string;
  const keyFlag = flag("--key");
  const keyFileFlag = flag("--key-file");
  if (keyFlag) {
    signingKeyHex = keyFlag.trim();
    keySource = "--key argument";
  } else if (keyFileFlag) {
    signingKeyHex = readFileSync(keyFileFlag, "utf-8").trim();
    keySource = keyFileFlag;
  } else if (env.APPSERVER_SIGNING_KEY) {
    signingKeyHex = env.APPSERVER_SIGNING_KEY.trim();
    keySource = "APPSERVER_SIGNING_KEY env";
  } else {
    const keyPath = join(env.DATA_DIR ?? "data", "appserver-signing-key.hex");
    if (!existsSync(keyPath)) {
      console.error(
        `No signing key: pass --key <hex>, --key-file <path>, or set APPSERVER_SIGNING_KEY ` +
          `(production: the appserver deployment env, or DATA_DIR/appserver-signing-key.hex on its volume)`,
      );
      process.exit(1);
    }
    signingKeyHex = readFileSync(keyPath, "utf-8").trim();
    keySource = keyPath;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(signingKeyHex!)) {
    console.error(
      `Signing key from ${keySource} is not 64 hex chars (32 bytes): ${signingKeyHex!.slice(0, 8)}…`,
    );
    process.exit(1);
  }

  const only = values("--only").filter((d) => d.length > 0);
  for (const did of only) {
    if (!/^did:(plc|web):\S+$/.test(did)) {
      console.error(`--only value is not a did:plc/did:web DID: ${did}`);
      process.exit(1);
    }
  }

  return {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
    single: argv.includes("--single"),
    only,
    didsFile: flag("--dids-file") ?? null,
    configUri: flag("--config") ?? env.REFERENCE_CONFIG ?? DEFAULT_REFERENCE_CONFIG,
    resultsPath: flag("--results") ?? "arbiter-config-migration.jsonl",
    skipPolicyCheck: argv.includes("--skip-policy-check"),
    policyLayersOverride: values("--policy-layer"),
    signingKeyHex: signingKeyHex!,
    keySource,
    arbiterUrl: arbiterUrl!.replace(/\/+$/, ""),
    arbiterDid: arbiterDid!,
    appserverDid,
    plcUrl: (env.PLC_DIRECTORY_URL ?? "https://plc.directory").replace(/\/+$/, ""),
    eventsDbPath: env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite",
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────

export class HttpFailure extends Error {
  readonly status: number;
  /** XRPC error name, e.g. `RecordNotFound` / `ErrPermissionDenied`. */
  readonly name2: string | undefined;
  constructor(status: number, xrpcError: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.name2 = xrpcError;
  }
}

/**
 * Failures worth retrying: network errors, 5xx/429, and the arbiter's
 * issuer-DID resolution failures. The arbiter's auth middleware fetches the
 * issuer's DID document per request; a fetch/parse failure there
 * ("unable to resolve issuer DID …", `error-atproto-identity-web-3/4`) is
 * almost always an appserver-origin flap behind the CDN, not a permanent
 * rejection.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof HttpFailure) {
    if (err.status >= 500 || err.status === 429) return true;
    return /unable to resolve issuer DID|error-atproto-identity-web-[34]\b/.test(err.message);
  }
  if (err instanceof Error) {
    return (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      err.message.includes("fetch") ||
      err.message.includes("network")
    );
  }
  return false;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!resp.ok) {
    const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const xrpcError = typeof obj.error === "string" ? obj.error : undefined;
    const message = typeof obj.message === "string" ? obj.message : text.slice(0, 200);
    throw new HttpFailure(resp.status, xrpcError, message);
  }
  return body;
}

/** Run `fn`, retrying transient failures with the standard backoff. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientFailure(err)) throw err;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RETRY_DELAYS_MS[attempt] ?? 0);
      await promise;
    }
  }
  throw lastErr;
}

// ─── DID resolution ──────────────────────────────────────────────────────

interface DidDocument {
  /** The `#atproto_pds` service endpoint, or null. */
  pdsEndpoint: string | null;
  /** The `#atproto` signing key as a `did:key:` string, or null. */
  signingKeyDid: string | null;
  /** First non-PDS service endpoint (used to spot the appserver's origin). */
  appserverEndpoint: string | null;
}

/** Host part of a did:web DID (first segment, port percent-decoded). */
export function didWebHost(did: string): string {
  const rest = did.slice("did:web:".length);
  const host = decodeURIComponent(rest.split(":")[0] ?? "");
  if (!host) throw new Error(`Invalid did:web DID: ${did}`);
  return host;
}

function didWebOrigin(did: string): string {
  const host = didWebHost(did);
  return /^localhost:\d+$/.test(host) || /^127\.0\.0\.1:\d+$/.test(host)
    ? `http://${host}`
    : `https://${host}`;
}

export async function resolveDidDocument(
  did: string,
  plcUrl: string,
): Promise<DidDocument> {
  let doc: Record<string, unknown>;
  if (did.startsWith("did:plc:")) {
    doc = (await fetchJson(`${plcUrl}/${did}/data`)) as Record<string, unknown>;
  } else if (did.startsWith("did:web:")) {
    doc = (await fetchJson(`${didWebOrigin(did)}/.well-known/did.json`)) as Record<string, unknown>;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  let pdsEndpoint: string | null = null;
  let signingKeyDid: string | null = null;
  let appserverEndpoint: string | null = null;

  const services = (doc["service"] ?? doc["services"]) as unknown;
  if (Array.isArray(services)) {
    for (const svc of services) {
      const s = svc as Record<string, unknown>;
      const id = typeof s["id"] === "string" ? s["id"] : "";
      const type = typeof s["type"] === "string" ? s["type"] : "";
      const endpoint = typeof s["serviceEndpoint"] === "string" ? s["serviceEndpoint"] : null;
      if (id === "#atproto_pds" || type === "AtprotoPersonalDataServer") pdsEndpoint = endpoint;
      if (id === "#space_roomy_appserver" || type === "RoomyAppserver") appserverEndpoint = endpoint;
    }
  } else if (services && typeof services === "object") {
    const map = services as Record<string, Record<string, unknown>>;
    const pds = map["atproto_pds"];
    if (pds && typeof pds["endpoint"] === "string") pdsEndpoint = pds["endpoint"];
  }

  const vm = doc["verificationMethod"];
  if (Array.isArray(vm)) {
    for (const m of vm) {
      const v = m as Record<string, unknown>;
      const multibase = v["publicKeyMultibase"];
      if (typeof multibase === "string" && multibase.startsWith("z")) {
        signingKeyDid = `did:key:${multibase}`;
        break;
      }
    }
  } else if (vm && typeof vm === "object") {
    const map = vm as Record<string, unknown>;
    const atproto = map["atproto"];
    if (typeof atproto === "string") signingKeyDid = atproto;
  }

  return { pdsEndpoint, signingKeyDid, appserverEndpoint };
}

// ─── Repo record reads (public) ──────────────────────────────────────────

export type RecordRead =
  | { found: true; value: Record<string, unknown> }
  | { found: false; reason: "missing" | "route-missing" };

/**
 * Public `com.atproto.repo.getRecord` read.
 *
 * - 400 `RecordNotFound` → missing (a real PDS's answer for a record that
 *   does not exist).
 * - 404 route → the host does not serve repo reads at all (the appserver
 *   itself is legacy spaces' `atproto_pds` and implements no repo routes —
 *   definitionally not a stewarded account's PDS).
 * - Anything else throws (retried upstream when transient).
 */
export async function getRecord(
  pdsEndpoint: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<RecordRead> {
  const params = new URLSearchParams({ repo, collection, rkey });
  try {
    const body = (await fetchJson(
      `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?${params}`,
    )) as Record<string, unknown>;
    const value = body["value"];
    if (!value || typeof value !== "object") {
      return { found: false, reason: "missing" };
    }
    return { found: true, value: value as Record<string, unknown> };
  } catch (err) {
    if (err instanceof HttpFailure) {
      if (err.name2 === "RecordNotFound") return { found: false, reason: "missing" };
      if (err.status === 404) return { found: false, reason: "route-missing" };
    }
    throw err;
  }
}

// ─── serviceAuth JWT (mirrors src/auth/serviceAuth.ts) ──────────────────

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function mintServiceAuthJwt(
  key: Secp256k1Keypair,
  aud: string,
  lxm: string,
  iss: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256K", typ: "JWT", kid: key.did() };
  const claims = {
    iss,
    sub: iss,
    aud,
    lxm,
    iat: now,
    exp: now + TOKEN_TTL_SEC,
    jti: randomBytes(16).toString("hex"),
  };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header), "utf8"));
  const claimsB64 = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${headerB64}.${claimsB64}`;
  const sig = await key.sign(Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${b64url(sig)}`;
}

// ─── Reference config ────────────────────────────────────────────────────

export interface ArbiterConfigContent {
  trustedScopes: string[];
  policyLayers: string[];
}

/** Parse `at://<did>/<collection>/<rkey>`; null when malformed. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/(did:(?:plc|web):[^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!m) return null;
  return { did: m[1]!, collection: m[2]!, rkey: m[3]! };
}

/**
 * Fetch the reference config record and validate its shape. The record's
 * `$type` is stripped; the resetConfig body only carries trustedScopes +
 * policyLayers.
 */
export async function fetchReferenceConfig(
  configUri: string,
  plcUrl: string,
): Promise<ArbiterConfigContent> {
  const parts = parseAtUri(configUri);
  if (!parts) throw new Error(`REFERENCE_CONFIG is not a valid at:// URI: ${configUri}`);
  const doc = await resolveDidDocument(parts.did, plcUrl);
  if (!doc.pdsEndpoint) {
    throw new Error(`Reference config DID ${parts.did} has no #atproto_pds service`);
  }
  const rec = await getRecord(doc.pdsEndpoint, parts.did, parts.collection, parts.rkey);
  if (!rec.found) {
    throw new Error(`Reference config record not found: ${configUri}`);
  }
  return validateConfigValue(rec.value, configUri);
}

export function validateConfigValue(value: Record<string, unknown>, source: string): ArbiterConfigContent {
  const type = value["$type"];
  if (type !== undefined && type !== CONFIG_COLLECTION) {
    throw new Error(`${source}: $type is ${JSON.stringify(type)}, expected "${CONFIG_COLLECTION}"`);
  }
  const trustedScopes = value["trustedScopes"];
  const policyLayers = value["policyLayers"];
  if (!Array.isArray(trustedScopes) || !trustedScopes.every((s) => typeof s === "string")) {
    throw new Error(`${source}: trustedScopes must be an array of strings`);
  }
  if (!Array.isArray(policyLayers) || !policyLayers.every((s) => typeof s === "string")) {
    throw new Error(`${source}: policyLayers must be an array of strings`);
  }
  return { trustedScopes: trustedScopes as string[], policyLayers: policyLayers as string[] };
}

/** Exact-content equality (order-sensitive arrays, $type ignored). */
export function configMatches(value: Record<string, unknown>, desired: ArbiterConfigContent): boolean {
  if (value["$type"] !== undefined && value["$type"] !== CONFIG_COLLECTION) return false;
  try {
    const actual = validateConfigValue(value, "existing record");
    return (
      JSON.stringify(actual.trustedScopes) === JSON.stringify(desired.trustedScopes) &&
      JSON.stringify(actual.policyLayers) === JSON.stringify(desired.policyLayers)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch every referenced policy layer record and confirm it exists and is a
 * `town.muni.arbiter.policy` record. resetConfig writes the URIs verbatim
 * without validation, but a broken layer fails the arbiter's config load —
 * fail here instead of fail-closing every reset arbiter.
 */
export async function validatePolicyLayers(
  config: ArbiterConfigContent,
  plcUrl: string,
): Promise<void> {
  for (const uri of config.policyLayers) {
    const parts = parseAtUri(uri);
    if (!parts) {
      throw new Error(`Policy layer is not a valid at://<did>/<collection>/<rkey> URI: ${uri}`);
    }
    if (parts.collection !== "town.muni.arbiter.policy") {
      throw new Error(
        `Policy layer must reference a town.muni.arbiter.policy record: ${uri}`,
      );
    }
    const doc = await resolveDidDocument(parts.did, plcUrl);
    if (!doc.pdsEndpoint) {
      throw new Error(`Policy layer DID ${parts.did} has no #atproto_pds service (${uri})`);
    }
    const rec = await getRecord(doc.pdsEndpoint, parts.did, parts.collection, parts.rkey);
    if (!rec.found) {
      throw new Error(`Policy layer record not found: ${uri}`);
    }
  }
}

// ─── resetConfig call ────────────────────────────────────────────────────

/**
 * `town.muni.arbiter.resetConfig` — recovery-admin-only hatch that replaces
 * the stewarded account's `town.muni.arbiter.config/self` record wholesale
 * (CAS putRecord) and re-onboards the arbiter. Never evaluates the policy
 * pipeline, so it works while the account is offboarded (exactly the state
 * this migration repairs).
 */
export async function callResetConfig(
  opts: MigrationOptions,
  key: Secp256k1Keypair,
  arbiterAccountDid: string,
  config: ArbiterConfigContent,
): Promise<void> {
  await withRetry(async () => {
    // Fresh token per attempt: the arbiter enforces jti replay protection,
    // so a retry must not reuse a token that may have already been consumed.
    const token = await mintServiceAuthJwt(key, opts.arbiterDid, RESET_CONFIG_NSID, opts.appserverDid);
    await fetchJson(`${opts.arbiterUrl}/xrpc/${RESET_CONFIG_NSID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        arbiterDid: arbiterAccountDid,
        trustedScopes: config.trustedScopes,
        policyLayers: config.policyLayers,
      }),
    });
  });
}

// ─── Enumeration ─────────────────────────────────────────────────────────

/**
 * Space DID list: `--dids-file`, `--only`, or the events DB `dids` table
 * (every DID the appserver created is a space — the same enumeration source
 * as migrate-spaces-to-pds.ts).
 */
export function listSpaceDids(opts: MigrationOptions): { dids: string[]; source: string } {
  if (opts.only.length > 0) return { dids: opts.only, source: "--only arguments" };
  if (opts.didsFile) {
    const dids = readFileSync(opts.didsFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return { dids, source: opts.didsFile };
  }
  const db = new Database(opts.eventsDbPath, { readonly: true });
  try {
    const rows = db.query("select did from dids order by did").all() as { did: string }[];
    return { dids: rows.map((r) => r.did), source: opts.eventsDbPath };
  } finally {
    db.close();
  }
}

// ─── Per-DID migration ───────────────────────────────────────────────────

export type Outcome =
  | "migrated"
  | "already-configured"
  | "differs"
  | "not-managed"
  | "dry-run"
  | "verify-failed"
  | "denied"
  | "failed"
  | "precheck-error";

export interface DidResult {
  did: string;
  outcome: Outcome;
  detail?: string;
}

export interface MigrationContext {
  opts: MigrationOptions;
  key: Secp256k1Keypair;
  desired: ArbiterConfigContent;
  /** The appserver's own origin (legacy spaces' atproto_pds points here). */
  appserverOrigin: string | null;
}

export async function migrateOneDid(did: string, ctx: MigrationContext): Promise<DidResult> {
  const { opts, desired } = ctx;
  const fail = (outcome: Outcome, detail?: string): DidResult => ({ did, outcome, detail });
  const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // 1. Resolve the space's DID document → PDS endpoint.
  let doc: DidDocument;
  try {
    doc = await withRetry(() => resolveDidDocument(did, opts.plcUrl));
  } catch (err) {
    return fail("precheck-error", `DID resolution failed: ${errMsg(err)}`);
  }
  if (!doc.pdsEndpoint) return fail("precheck-error", "DID doc has no #atproto_pds service");
  const pds = doc.pdsEndpoint;

  // Legacy spaces' atproto_pds is the appserver itself — never arbiter-stewarded.
  if (ctx.appserverOrigin && sameOrigin(pds, ctx.appserverOrigin)) {
    return fail("not-managed", "atproto_pds is the appserver itself (legacy self-provisioned DID)");
  }

  // 2. Stewardship pre-check: the public arbiter service record must point
  //    at THIS arbiter server (same discovery the arbiter-manager uses).
  let svc: RecordRead;
  try {
    svc = await withRetry(() => getRecord(pds, did, SERVICE_COLLECTION, "self"));
  } catch (err) {
    return fail("precheck-error", `service record read failed: ${errMsg(err)}`);
  }
  if (!svc.found) {
    return fail(
      "not-managed",
      svc.reason === "route-missing"
        ? "PDS does not serve repo reads (not a stewarded account's PDS)"
        : `no ${SERVICE_COLLECTION}/self record`,
    );
  }
  const svcDid = svc.value["did"];
  if (svcDid !== opts.arbiterDid) {
    return fail("not-managed", `service record points at ${JSON.stringify(svcDid) ?? "???"}`);
  }

  // 3. Compare the existing config record.
  let cfg: RecordRead;
  try {
    cfg = await withRetry(() => getRecord(pds, did, CONFIG_COLLECTION, "self"));
  } catch (err) {
    return fail("precheck-error", `config record read failed: ${errMsg(err)}`);
  }
  if (cfg.found && configMatches(cfg.value, desired)) {
    return fail("already-configured", "config record already matches the reference");
  }
  if (cfg.found && !opts.force) {
    return fail("differs", "config record exists but differs from the reference (rerun with --force to overwrite)");
  }

  // 4. Apply.
  if (!opts.apply) {
    return fail("dry-run", cfg.found ? "would overwrite differing config (--force)" : "would resetConfig");
  }
  try {
    await callResetConfig(opts, ctx.key, did, desired);
  } catch (err) {
    if (err instanceof HttpFailure && err.name2 === "ErrPermissionDenied") {
      return fail(
        "denied",
        `arbiter rejected resetConfig (${err.message || "ErrPermissionDenied"}) — account not stewarded by this server, or its recovery/self record does not designate ${opts.appserverDid}`,
      );
    }
    return fail("failed", `resetConfig failed: ${errMsg(err)}`);
  }

  // 5. Verify the record landed.
  let check: RecordRead;
  try {
    check = await withRetry(() => getRecord(pds, did, CONFIG_COLLECTION, "self"));
  } catch (err) {
    return fail("verify-failed", `post-write read failed: ${errMsg(err)}`);
  }
  if (!check.found || !configMatches(check.value, desired)) {
    return fail("verify-failed", "config record does not match the reference after resetConfig");
  }
  return { did, outcome: "migrated" };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────

export interface MigrationSummary {
  total: number;
  migrated: number;
  alreadyConfigured: number;
  differs: number;
  notManaged: number;
  dryRun: number;
  verifyFailed: number;
  denied: number;
  failed: number;
  precheckError: number;
}

/**
 * Outcome → MigrationSummary field. Outcome names are kebab-case wire
 * values; the summary uses camelCase fields.
 */
const SUMMARY_KEYS: Record<Outcome, Exclude<keyof MigrationSummary, "total">> = {
  migrated: "migrated",
  "already-configured": "alreadyConfigured",
  differs: "differs",
  "not-managed": "notManaged",
  "dry-run": "dryRun",
  "verify-failed": "verifyFailed",
  denied: "denied",
  failed: "failed",
  "precheck-error": "precheckError",
};

/**
 * Outcomes that satisfy `--single`: a real action (performed, or would-be in
 * a dry-run). Skips (already-configured, not-managed, differs) never stop
 * the run.
 */
const SINGLE_STOP_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "migrated",
  "dry-run",
  "verify-failed",
  "denied",
  "failed",
  "precheck-error",
]);

export async function runMigration(opts: MigrationOptions): Promise<MigrationSummary> {
  const key = await Secp256k1Keypair.import(opts.signingKeyHex, { exportable: true });
  const keyMultibase = key.did().replace(/^did:key:/, "");
  const log = (line: string) => console.log(line);

  log("== arbiter config migration ==");
  log(`appserver DID : ${opts.appserverDid}`);
  log(`signing key   : ${keyMultibase} (from ${opts.keySource})`);
  log(`arbiter       : ${opts.arbiterDid} @ ${opts.arbiterUrl}`);
  log(`mode          : ${opts.apply ? "APPLY" : "DRY-RUN (pass --apply to mutate)"}`);

  // Safe check 1: the signing key must be the one published in the
  // appserver's DID document — the arbiter verifies JWTs against it.
  let appserverDoc: DidDocument;
  try {
    appserverDoc = await resolveDidDocument(opts.appserverDid, opts.plcUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const hint = opts.appserverDid.startsWith("did:web:")
      ? ` (tried ${didWebOrigin(opts.appserverDid)}/.well-known/did.json — check APPSERVER_DID; ` +
        `a local dev value like did:web:localhost%3A8080 only works with a local appserver running)`
      : "";
    throw new Error(
      `Failed to resolve the appserver DID document (${opts.appserverDid}): ${detail}${hint}`,
    );
  }
  if (appserverDoc.signingKeyDid !== key.did()) {
    throw new Error(
      `Signing key mismatch: ${opts.appserverDid}'s DID document publishes ` +
        `${appserverDoc.signingKeyDid ?? "no key"}, but the provided key is ${key.did()}. ` +
        `The arbiter would reject every token. Check the key source (${opts.keySource}).`,
    );
  }
  log(`key check     : matches ${opts.appserverDid} DID document Multikey`);

  // Safe check 2: the reference config must exist and be well-formed. Its
  // trusted scopes are used verbatim; the policy layers default to Roomy's
  // default policy record (see DEFAULT_POLICY_LAYERS) — the reference
  // record's own policyLayers are NOT applied, so the config installed here
  // always matches what the appserver provisions. All layers must be live
  // records.
  const fetched = await fetchReferenceConfig(opts.configUri, opts.plcUrl);
  const hasLayerOverride = opts.policyLayersOverride.length > 0;
  const desired: ArbiterConfigContent = {
    trustedScopes: fetched.trustedScopes,
    policyLayers: hasLayerOverride ? opts.policyLayersOverride : DEFAULT_POLICY_LAYERS,
  };
  log(
    `reference cfg : ${JSON.stringify(desired)}` +
      (hasLayerOverride ? " (--policy-layer override)" : " (default layers)"),
  );
  if (!opts.skipPolicyCheck) {
    await validatePolicyLayers(desired, opts.plcUrl);
    log(`policy layers : ${desired.policyLayers.length} record(s) verified`);
  }

  const summary: MigrationSummary = {
    total: 0,
    migrated: 0,
    alreadyConfigured: 0,
    differs: 0,
    notManaged: 0,
    dryRun: 0,
    verifyFailed: 0,
    denied: 0,
    failed: 0,
    precheckError: 0,
  };

  const { dids, source } = listSpaceDids(opts);
  summary.total = dids.length;
  log(`space DIDs    : ${dids.length} (from ${source})`);
  if (opts.force) log("force         : differing configs will be overwritten");

  const append = (r: DidResult): void => {
    appendFileSync(
      opts.resultsPath,
      JSON.stringify({ ts: new Date().toISOString(), ...r }) + "\n",
    );
  };

  const ctx: MigrationContext = {
    opts,
    key,
    desired,
    appserverOrigin: appserverDoc.appserverEndpoint,
  };

  const absorb = (r: DidResult): boolean => {
    summary[SUMMARY_KEYS[r.outcome]] += 1;
    append(r);
    switch (r.outcome) {
      case "migrated":
        log(`[MIGRATED] ${r.did}`);
        break;
      case "already-configured":
        log(`[SKIP] ${r.did} (${r.detail})`);
        break;
      case "not-managed":
        log(`[SKIP] ${r.did} (not managed by this arbiter: ${r.detail})`);
        break;
      case "dry-run":
        log(`[DRY-RUN] ${r.did} — ${r.detail}`);
        break;
      case "differs":
      case "denied":
      case "verify-failed":
      case "precheck-error":
        log(`[FLAGGED] ${r.did} — ${r.detail}`);
        break;
      case "failed":
        log(`[FAILED] ${r.did} — ${r.detail}`);
        break;
    }
    return SINGLE_STOP_OUTCOMES.has(r.outcome);
  };

  if (opts.single) {
    let processed = 0;
    for (const did of dids) {
      processed++;
      const r = await migrateOneDid(did, ctx);
      if (absorb(r)) {
        log(
          `[SINGLE] stopping after first action (${r.outcome}) — ` +
            `${processed} of ${dids.length} DIDs processed`,
        );
        break;
      }
    }
  } else {
    for (let i = 0; i < dids.length; i += BATCH_SIZE) {
      const batch = dids.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((did) => migrateOneDid(did, ctx)));
      for (const r of results) absorb(r);
      if (i + BATCH_SIZE < dids.length) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1000);
        await promise;
      }
    }
  }

  return summary;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function formatSummary(s: MigrationSummary): string {
  return [
    `${s.migrated} migrated`,
    `${s.alreadyConfigured} already configured`,
    `${s.notManaged} not managed`,
    s.dryRun > 0 ? `${s.dryRun} would be migrated (dry-run)` : null,
    s.differs > 0 ? `${s.differs} flagged (differing config)` : null,
    s.denied > 0 ? `${s.denied} denied by arbiter` : null,
    s.verifyFailed > 0 ? `${s.verifyFailed} verify failures` : null,
    s.precheckError > 0 ? `${s.precheckError} precheck errors` : null,
    s.failed > 0 ? `${s.failed} failed` : null,
  ]
    .filter((p) => p !== null)
    .join(", ");
}

if (import.meta.main) {
  const opts = parseArgs();
  runMigration(opts)
    .then((summary) => {
      console.log(`\nDone: ${formatSummary(summary)}`);
      console.log(`Outcome manifest: ${opts.resultsPath}`);
      const attention =
        summary.differs + summary.denied + summary.verifyFailed + summary.precheckError + summary.failed;
      if (attention > 0) {
        console.log(`⚠ ${attention} space(s) need manual attention — see the manifest`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}