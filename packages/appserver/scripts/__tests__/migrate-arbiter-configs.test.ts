/**
 * Tests for the arbiter-config migration script.
 *
 * Spins mock PLC / PDS / arbiter / appserver-identity servers and drives
 * `runMigration` directly (not via CLI subprocess), covering the full
 * per-DID pipeline: stewardship pre-check, config comparison, resetConfig
 * call shape (JWT claims + body), verification, and idempotent re-runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secp256k1Keypair } from "@atproto/crypto";
import { runMigration, type DidResult, type MigrationOptions } from "../migrate-arbiter-configs.ts";

// ─── Fixture constants ──────────────────────────────────────────────────────

const ARBITER_DID = "did:web:arbiter.test.example";
const REFERENCE_CONFIG = {
  $type: "town.muni.arbiter.config",
  trustedScopes: ["space.roomy.authComplete"],
  policyLayers: ["at://did:plc:policy-source/town.muni.arbiter.policy/simple-admins"],
};
/**
 * The config the script installs: trusted scopes from the reference record,
 * policy layers defaulted to Roomy's own policy record (the script's
 * DEFAULT_POLICY_LAYERS — mirrors REFERENCE_ARBITER_CONFIG in the appserver).
 */
const ROOMY_DEFAULT_POLICY_LAYER =
  "at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default";
const DESIRED_CONFIG = {
  $type: "town.muni.arbiter.config",
  trustedScopes: ["space.roomy.authComplete"],
  policyLayers: [ROOMY_DEFAULT_POLICY_LAYER],
};
const SERVICE_RECORD = { $type: "town.muni.arbiter.service", did: ARBITER_DID };
const FOREIGN_SERVICE_RECORD = { $type: "town.muni.arbiter.service", did: "did:web:other.example" };

/** Stewarded account with no config record — the migration target state. */
const DID_MISSING = "did:plc:steward-missing";
/** Second stewarded account with no config (proves --single stops). */
const DID_MISSING2 = "did:plc:steward-missing-2";
/** Stewarded account already holding the reference config. */
const DID_CURRENT = "did:plc:steward-current";
/** Stewarded account holding a DIFFERENT config (must not be clobbered). */
const DID_DIFFERS = "did:plc:steward-differs";
/** Legacy self-provisioned did:plc whose atproto_pds is the appserver. */
const DID_LEGACY = "did:plc:legacy-space";
/** Stewarded by a different arbiter server. */
const DID_FOREIGN = "did:plc:foreign-arbiter";
/** PDS that does not implement repo reads at all. */
const DID_PDS404 = "did:plc:pds-route-404";

// ─── Mock servers ───────────────────────────────────────────────────────────

interface ResetConfigCall {
  authorization: string;
  body: { arbiterDid: string; trustedScopes: string[]; policyLayers: string[] };
}

interface MockStack {
  arbiterUrl: string;
  appserverUrl: string;
  appserverDid: string;
  plcUrl: string;
  pdsUrl: string;
  pds404Url: string;
  resetConfigCalls: ResetConfigCall[];
  /** Simulated repo contents, keyed by at:// URI. */
  records: Map<string, Record<string, unknown>>;
  /** DID → PDS endpoint served by the mock PLC. */
  plcDocs: Map<string, string>;
  /** When set, the arbiter denies this account with ErrPermissionDenied. */
  denyDids: Set<string>;
  /** When set, the arbiter fails THIS account's first attempt with an
   *  issuer-resolution error (transient; retry must succeed). */
  failFirstAttemptFor: Set<string>;
  servers: Array<{ stop(): Promise<void> }>;
}

async function startMocks(keyMultibase: string): Promise<MockStack> {
  const stack: MockStack = {
    arbiterUrl: "",
    appserverUrl: "",
    appserverDid: "",
    plcUrl: "",
    pdsUrl: "",
    pds404Url: "",
    resetConfigCalls: [],
    records: new Map(),
    plcDocs: new Map(),
    denyDids: new Set(),
    failFirstAttemptFor: new Set(),
    servers: [],
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // PLC directory: GET /<did>/data → DID document.
  const plc = Bun.serve({
    port: 0,
    fetch(req) {
      const did = decodeURIComponent(new URL(req.url).pathname.slice(1).replace(/\/data$/, ""));
      const pds = stack.plcDocs.get(did);
      if (!pds) return json({ error: "DidNotFound" }, 404);
      return json({
        verificationMethods: { atproto: "did:key:z6MkTestNotUsed" },
        services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: pds } },
      });
    },
  });
  stack.plcUrl = `http://127.0.0.1:${plc.port}`;
  stack.servers.push(plc);

  // Stewarded accounts' PDS: serves public repo reads.
  const pds = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/com.atproto.repo.getRecord")) {
        return json({ error: "NotFound", message: "route not found" }, 404);
      }
      const repo = url.searchParams.get("repo") ?? "";
      const collection = url.searchParams.get("collection") ?? "";
      const rkey = url.searchParams.get("rkey") ?? "";
      const value = stack.records.get(`at://${repo}/${collection}/${rkey}`);
      if (!value) return json({ error: "RecordNotFound", message: "record not found" }, 400);
      return json({ uri: `at://${repo}/${collection}/${rkey}`, cid: "bafytest", value });
    },
  });
  stack.pdsUrl = `http://127.0.0.1:${pds.port}`;
  stack.servers.push(pds);

  // A PDS that 404s every route (does not serve repo reads at all).
  const pds404 = Bun.serve({
    port: 0,
    fetch() {
      return json({ error: "NotFound", message: "route not found" }, 404);
    },
  });
  stack.pds404Url = `http://127.0.0.1:${pds404.port}`;
  stack.servers.push(pds404);

  // Arbiter server: validates the resetConfig call and simulates the write.
  const arbiter = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/town.muni.arbiter.resetConfig")) {
        return json({ error: "NotFound" }, 404);
      }
      const body = (await req.json()) as ResetConfigCall["body"];
      stack.resetConfigCalls.push({
        authorization: req.headers.get("Authorization") ?? "",
        body,
      });
      const priorAttempts = stack.resetConfigCalls.filter(
        (c) => c.body.arbiterDid === body.arbiterDid,
      ).length;
      if (stack.failFirstAttemptFor.has(body.arbiterDid) && priorAttempts === 1) {
        // First attempt only: mimic the arbiter's auth middleware failing to
        // fetch/decode the issuer DID document (e.g. appserver origin 502).
        return json(
          {
            error: "ErrIssuerResolution",
            message:
              "unable to resolve issuer DID `did:web:api.roomy.space`: error-atproto-identity-web-4 " +
              "Failed to parse DID document: https://api.roomy.space/.well-known/did.json " +
              "error decoding response body",
          },
          400,
        );
      }
      if (stack.denyDids.has(body.arbiterDid)) {
        return json(
          { error: "ErrPermissionDenied", message: "caller is not the recovery admin" },
          400,
        );
      }
      // Simulate the arbiter's CAS putRecord into the account's repo.
      stack.records.set(`at://${body.arbiterDid}/town.muni.arbiter.config/self`, {
        $type: "town.muni.arbiter.config",
        trustedScopes: body.trustedScopes,
        policyLayers: body.policyLayers,
      });
      return json({ ok: true });
    },
  });
  stack.arbiterUrl = `http://127.0.0.1:${arbiter.port}`;
  stack.servers.push(arbiter);

  // The appserver: serves its DID document with the migration key as Multikey.
  // `self` is captured after Bun.serve to avoid a self-referencing closure
  // in the initializer (the fetch handler needs the port before the const
  // binding exists).
  let self: { port: number | undefined } = { port: undefined };
  const appserver = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/.well-known/did.json") return json({ error: "NotFound" }, 404);
      const did = `did:web:localhost%3A${self.port}`;
      return json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto`,
            type: "Multikey",
            controller: did,
            publicKeyMultibase: keyMultibase,
          },
        ],
        service: [
          {
            id: "#space_roomy_appserver",
            type: "RoomyAppserver",
            serviceEndpoint: `http://localhost:${self.port}`,
          },
        ],
      });
    },
  });
  self = appserver;
  stack.appserverUrl = `http://localhost:${appserver.port}`;
  stack.appserverDid = `did:web:localhost%3A${appserver.port}`;
  stack.servers.push(appserver);

  return stack;
}

// ─── Options builder ────────────────────────────────────────────────────────

let tmpDir: string;
let mocks: MockStack;
let keyHex: string;

function makeOpts(overrides: Partial<MigrationOptions> = {}): MigrationOptions {
  return {
    apply: false,
    force: false,
    single: false,
    only: [],
    didsFile: null,
    policyLayersOverride: [],
    configUri: "at://did:plc:ref-config/town.muni.arbiter.config/self",
    resultsPath: join(tmpDir, "results.jsonl"),
    skipPolicyCheck: false,
    signingKeyHex: keyHex,
    keySource: "test fixture",
    arbiterUrl: mocks.arbiterUrl,
    arbiterDid: ARBITER_DID,
    appserverDid: mocks.appserverDid,
    plcUrl: mocks.plcUrl,
    eventsDbPath: join(tmpDir, "events.sqlite"),
    ...overrides,
    // Partial-spread widens optional props to `| undefined`; the defaults
    // above guarantee every field.
  } as MigrationOptions;
}

function createEventsDb(dids: string[]): void {
  const db = new Database(makeOpts().eventsDbPath, { create: true });
  db.exec("create table dids (did text primary key) strict");
  const insert = db.prepare("insert into dids (did) values (?)");
  for (const did of dids) insert.run(did);
  db.close();
}

function seedRepoData(): void {
  const r = mocks.records;
  // Reference config + policy layers (both live on the mock PDS).
  r.set("at://did:plc:ref-config/town.muni.arbiter.config/self", structuredClone(REFERENCE_CONFIG));
  r.set("at://did:plc:policy-source/town.muni.arbiter.policy/simple-admins", {
    $type: "town.muni.arbiter.policy",
    policy: "package arbiter\n",
  });
  // Roomy's own default policy record (the --policy-layer override target).
  r.set("at://did:plc:roomy-policy/town.muni.arbiter.policy/default", {
    $type: "town.muni.arbiter.policy",
    policy: "package arbiter\n",
  });
  // The production roomy-default policy record — the script's default layer.
  r.set(ROOMY_DEFAULT_POLICY_LAYER, {
    $type: "town.muni.arbiter.policy",
    policy: "package arbiter\n",
  });
  // Stewardship service records.
  for (const did of [DID_MISSING, DID_MISSING2, DID_CURRENT, DID_DIFFERS]) {
    r.set(`at://${did}/town.muni.arbiter.service/self`, structuredClone(SERVICE_RECORD));
  }
  r.set(`at://${DID_FOREIGN}/town.muni.arbiter.service/self`, structuredClone(FOREIGN_SERVICE_RECORD));
  // Existing configs.
  r.set(`at://${DID_CURRENT}/town.muni.arbiter.config/self`, structuredClone(DESIRED_CONFIG));
  r.set(`at://${DID_DIFFERS}/town.muni.arbiter.config/self`, {
    $type: "town.muni.arbiter.config",
    trustedScopes: ["community.lexicon.authCalendar"],
    policyLayers: [],
  });
  // PLC docs: stewarded DIDs → mock PDS; legacy → appserver origin; pds404 → its server.
  for (
    const did of [
      DID_MISSING,
      DID_MISSING2,
      DID_CURRENT,
      DID_DIFFERS,
      DID_FOREIGN,
      "did:plc:ref-config",
      "did:plc:policy-source",
      "did:plc:roomy-policy",
      "did:plc:cyqufxsezk33hqulcilckna6",
    ]
  ) {
    mocks.plcDocs.set(did, mocks.pdsUrl);
  }
  mocks.plcDocs.set(DID_LEGACY, mocks.appserverUrl);
  mocks.plcDocs.set(DID_PDS404, mocks.pds404Url);
}

function readManifest(): DidResult[] {
  const path = makeOpts().resultsPath;

  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as DidResult);
}

function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(c!, "base64url").toString("utf8")),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "arbiter-config-migration-"));
  const key = await Secp256k1Keypair.create({ exportable: true });
  keyHex = Buffer.from(await key.export()).toString("hex");
  mocks = await startMocks(key.did().replace(/^did:key:/, ""));
  seedRepoData();
});

afterEach(async () => {
  for (const server of mocks.servers) await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrate-arbiter-configs", () => {
  test("applies resetConfig to stewarded accounts missing a config record", async () => {
    createEventsDb([DID_MISSING]);
    const summary = await runMigration(makeOpts({ apply: true }));

    expect(summary.migrated).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(1);

    const call = mocks.resetConfigCalls[0]!;
    expect(call.body).toEqual({
      arbiterDid: DID_MISSING,
      trustedScopes: DESIRED_CONFIG.trustedScopes,
      policyLayers: DESIRED_CONFIG.policyLayers,
    });

    expect(call.authorization.startsWith("Bearer ")).toBe(true);
    const token = call.authorization.slice("Bearer ".length);
    const { header, claims } = decodeJwt(token);
    expect(header.alg).toBe("ES256K");
    expect(claims.iss).toBe(mocks.appserverDid);
    expect(claims.sub).toBe(mocks.appserverDid);
    expect(claims.aud).toBe(ARBITER_DID);
    expect(claims.lxm).toBe("town.muni.arbiter.resetConfig");
    expect(typeof claims.iat).toBe("number");
    expect(claims.exp).toBeGreaterThan(claims.iat as number);
    expect(typeof claims.jti).toBe("string");

    // The post-write verification read sees the record the arbiter wrote.
    expect(mocks.records.get(`at://${DID_MISSING}/town.muni.arbiter.config/self`)).toBeDefined();

    const manifest = readManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.outcome).toBe("migrated");
  });

  test("skips accounts that already hold the reference config", async () => {
    createEventsDb([DID_CURRENT]);
    const summary = await runMigration(makeOpts({ apply: true }));

    expect(summary.alreadyConfigured).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(0);
  });

  test("flags differing configs without clobbering; --force overwrites", async () => {
    createEventsDb([DID_DIFFERS]);

    const flagged = await runMigration(makeOpts({ apply: true }));
    expect(flagged.differs).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(0);
    // The differing config is untouched.
    expect(mocks.records.get(`at://${DID_DIFFERS}/town.muni.arbiter.config/self`)).toEqual({
      $type: "town.muni.arbiter.config",
      trustedScopes: ["community.lexicon.authCalendar"],
      policyLayers: [],
    });

    const forced = await runMigration(makeOpts({ apply: true, force: true }));
    expect(forced.migrated).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(1);
    expect(mocks.records.get(`at://${DID_DIFFERS}/town.muni.arbiter.config/self`)).toEqual({
      $type: "town.muni.arbiter.config",
      trustedScopes: DESIRED_CONFIG.trustedScopes,
      policyLayers: DESIRED_CONFIG.policyLayers,
    });
  });

  test("skips legacy spaces and foreign-arbiter accounts without touching the arbiter", async () => {
    createEventsDb([DID_LEGACY, DID_FOREIGN, DID_PDS404]);
    const summary = await runMigration(makeOpts({ apply: true }));

    expect(summary.notManaged).toBe(3);
    expect(summary.migrated).toBe(0);
    expect(mocks.resetConfigCalls).toHaveLength(0);

    const manifest = readManifest();
    const legacy = manifest.find((r) => r.did === DID_LEGACY);
    expect(legacy?.outcome).toBe("not-managed");
    expect(legacy?.detail).toContain("legacy");
    const foreign = manifest.find((r) => r.did === DID_FOREIGN);
    expect(foreign?.detail).toContain("did:web:other");
  });

  test("dry-run (default) never calls the arbiter", async () => {
    createEventsDb([DID_MISSING, DID_CURRENT]);
    const summary = await runMigration(makeOpts());

    expect(summary.dryRun).toBe(1);
    expect(summary.alreadyConfigured).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(0);
  });

  test("aborts before any mutation when the signing key mismatches the DID document", async () => {
    createEventsDb([DID_MISSING]);
    const wrongKey = await Secp256k1Keypair.create({ exportable: true });
    const wrongHex = Buffer.from(await wrongKey.export()).toString("hex");

    expect(
      runMigration(makeOpts({ apply: true, signingKeyHex: wrongHex })),
    ).rejects.toThrow(/Signing key mismatch/);
    expect(mocks.resetConfigCalls).toHaveLength(0);
  });

  test("a successful migration re-run is a full no-op (idempotent)", async () => {
    createEventsDb([DID_MISSING]);

    const first = await runMigration(makeOpts({ apply: true }));
    expect(first.migrated).toBe(1);

    const second = await runMigration(makeOpts({ apply: true }));
    expect(second.alreadyConfigured).toBe(1);
    expect(second.migrated).toBe(0);
    expect(mocks.resetConfigCalls).toHaveLength(1); // still only the first run's call
  });

  test("flags ErrPermissionDenied from the arbiter without retrying blindly", async () => {
    createEventsDb([DID_MISSING]);
    mocks.denyDids.add(DID_MISSING);

    const summary = await runMigration(makeOpts({ apply: true }));
    expect(summary.denied).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(1); // single call, no retry loop
    // Nothing was written.
    expect(mocks.records.get(`at://${DID_MISSING}/town.muni.arbiter.config/self`)).toBeUndefined();
  });

  test("--only bypasses the events DB and processes exactly the listed DIDs", async () => {
    createEventsDb([DID_MISSING, DID_CURRENT]);
    const summary = await runMigration(makeOpts({ apply: true, only: [DID_MISSING] }));

    expect(summary.total).toBe(1);
    expect(summary.migrated).toBe(1);
  });

  test("a --dids-file drives enumeration with comment lines ignored", async () => {
    const didsPath = join(tmpDir, "dids.txt");
    writeFileSync(didsPath, `${DID_MISSING}\n# comment\n${DID_LEGACY}\n`);

    const summary = await runMigration(makeOpts({ apply: true, didsFile: didsPath }));
    expect(summary.migrated).toBe(1);
    expect(summary.notManaged).toBe(1);
  });

  test("policy-layer validation runs before any resetConfig call", async () => {
    createEventsDb([DID_MISSING]);
    // Remove the default (Roomy) policy record from the mock PDS — the
    // script's default layers point at it.
    mocks.records.delete(ROOMY_DEFAULT_POLICY_LAYER);

    expect(runMigration(makeOpts({ apply: true }))).rejects.toThrow(/Policy layer record not found/);
    expect(mocks.resetConfigCalls).toHaveLength(0);
  });

  test("--single stops after the first real action (success or failure)", async () => {
    createEventsDb([DID_LEGACY, DID_CURRENT, DID_MISSING, DID_MISSING2]);
    const summary = await runMigration(makeOpts({ apply: true, single: true }));

    // Skips (legacy, already-configured) did not stop the run; the first
    // real action (missing config → migrated) did.
    expect(summary.notManaged).toBe(1);
    expect(summary.alreadyConfigured).toBe(1);
    expect(summary.migrated).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(1);
    expect(mocks.resetConfigCalls[0]!.body.arbiterDid).toBe(DID_MISSING);
    // The manifest holds exactly the three processed DIDs, not the fourth.
    expect(readManifest().map((r) => r.did)).toEqual([DID_LEGACY, DID_CURRENT, DID_MISSING]);
  });

  test("--single in dry-run stops at the first would-be action", async () => {
    createEventsDb([DID_CURRENT, DID_MISSING, DID_MISSING2]);
    const summary = await runMigration(makeOpts({ single: true }));

    expect(summary.alreadyConfigured).toBe(1);
    expect(summary.dryRun).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(0);
    expect(readManifest().map((r) => r.did)).toEqual([DID_CURRENT, DID_MISSING]);
  });

  test("--single processes the whole list when every outcome is a skip", async () => {
    createEventsDb([DID_LEGACY, DID_CURRENT, DID_DIFFERS]);
    const summary = await runMigration(makeOpts({ apply: true, single: true }));

    expect(summary.notManaged).toBe(1);
    expect(summary.alreadyConfigured).toBe(1);
    expect(summary.differs).toBe(1);
    expect(mocks.resetConfigCalls).toHaveLength(0);
    expect(readManifest()).toHaveLength(3);
  });

  test("--policy-layer overrides the reference record's policyLayers", async () => {
    createEventsDb([DID_MISSING]);
    const summary = await runMigration(
      makeOpts({
        apply: true,
        only: [DID_MISSING],
        policyLayersOverride: ["at://did:plc:roomy-policy/town.muni.arbiter.policy/default"],
      }),
    );

    expect(summary.migrated).toBe(1);
    // The resetConfig body carries the overridden layer, not the record's.
    expect(mocks.resetConfigCalls[0]!.body.policyLayers).toEqual([
      "at://did:plc:roomy-policy/town.muni.arbiter.policy/default",
    ]);
    expect(mocks.resetConfigCalls[0]!.body.trustedScopes).toEqual(REFERENCE_CONFIG.trustedScopes);
  });

  test("--policy-layer targets are validated before any resetConfig call", async () => {
    createEventsDb([DID_MISSING]);
    // The overridden layer's DID resolves (mock PLC) but its record is absent
    // from the PDS → validatePolicyLayers must hard-abort.
    mocks.plcDocs.set("did:plc:missing-policy", mocks.pdsUrl);
    expect(
      runMigration(
        makeOpts({
          apply: true,
          policyLayersOverride: ["at://did:plc:missing-policy/town.muni.arbiter.policy/default"],
        }),
      ),
    ).rejects.toThrow(/Policy layer record not found/);
    expect(mocks.resetConfigCalls).toHaveLength(0);
  });

  test("issuer-resolution failures are retried as transient", async () => {
    createEventsDb([DID_MISSING]);
    // First attempt fails with the arbiter's "cannot fetch/parse the issuer
    // DID doc" error; the retry (fresh token) succeeds.
    mocks.failFirstAttemptFor.add(DID_MISSING);

    const summary = await runMigration(makeOpts({ apply: true }));
    expect(summary.migrated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mocks.resetConfigCalls).toHaveLength(2);
    expect(mocks.records.get(`at://${DID_MISSING}/town.muni.arbiter.config/self`)).toBeDefined();
  });
});