#!/usr/bin/env bun
/**
 * Write-path profiler for `space.roomy.space.sendEvents`.
 *
 * Boots the real appserver (worker pool, real per-space DBs on disk) against a
 * seeded space and reports, per sendEvents call:
 *
 *   - end-to-end latency percentiles and throughput
 *   - DB worker round-trips, split by destination DB
 *   - time inside each stage of StreamManager.sendEvents
 *   - every outbound (non-local) network fetch the write path made
 *
 * The network line is the important one: the write path is supposed to be
 * local-only, so any non-local fetch listed here is a defect, not a slow step.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
 *     bun run packages/appserver/perf/probe-sendevents.ts [options]
 *
 * Options:
 *   --batch <n>        events per call (default 1)
 *   --iterations <n>   calls measured (default 20)
 *   --warmup <n>       calls discarded (default 3)
 *   --concurrency <n>  parallel in-flight calls (default 1)
 *   --seed-profile     pre-populate the author's profile row
 *   --keep             keep the temp data dir
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openSpaceDb, openGlobalDb } from "../src/db/db.ts";
import { WorkerLink } from "../src/db/asyncDatabase.ts";
import { StreamManager } from "../src/streams/StreamManager.ts";
import { Router } from "../src/invalidation/router.ts";
import { _setAdminDids } from "../src/admin.ts";
import { _resetHydrationInflight } from "../src/hydration/userHydration.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../src/embed/sweeper.ts";
import { _resetSearchIndexer, stopSearchIndexer } from "../src/search/indexer.ts";
import { _resetProfileStoreCache } from "../src/queries/profileStore.ts";

// ─── Args ─────────────────────────────────────────────────────────────────

const argv = process.argv;
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const BATCH = numArg("batch", 1);
const ITERATIONS = numArg("iterations", 20);
const WARMUP = numArg("warmup", 3);
const CONCURRENCY = numArg("concurrency", 1);
const SEED_PROFILE = argv.includes("--seed-profile");
const KEEP = argv.includes("--keep");

const USER = "did:plc:probe-user";
const SPACE = "did:plc:probe-space";

// ─── Instrumentation ──────────────────────────────────────────────────────

/** Round-trips by destination DB, and wall time by worker request type. */
const rttByDest = new Map<string, number>();
const msByType = new Map<string, number>();
const countByType = new Map<string, number>();
let recording = false;

const origSend = WorkerLink.prototype.send;
WorkerLink.prototype.send = function (
  req: Parameters<WorkerLink["send"]>[0],
  route?: Parameters<WorkerLink["send"]>[1],
) {
  const dest = route?.targetDb ?? "events";
  const promise = origSend.call(this, req, route) as Promise<unknown>;
  if (!recording) return promise;
  const start = performance.now();
  rttByDest.set(dest, (rttByDest.get(dest) ?? 0) + 1);
  countByType.set(req.type, (countByType.get(req.type) ?? 0) + 1);
  const done = () => msByType.set(req.type, (msByType.get(req.type) ?? 0) + (performance.now() - start));
  promise.then(done, done);
  return promise;
};

/** Stacked stage timings inside StreamManager.sendEvents. */
type Stage = "insert" | "profiles" | "applyBatch" | "invalidation" | "total";
const stageMs: Record<Stage, number> = {
  insert: 0, profiles: 0, applyBatch: 0, invalidation: 0, total: 0,
};
const stageCalls: Record<Stage, number> = {
  insert: 0, profiles: 0, applyBatch: 0, invalidation: 0, total: 0,
};

/**
 * Wrap one prototype method with a timer. Uses the runtime receiver (`this`),
 * not the prototype object, so class private fields resolve.
 */
const timeStage = <T extends object>(proto: T, key: keyof T, stage: Stage) => {
  const orig = proto[key] as unknown as (...a: unknown[]) => Promise<unknown>;
  const wrapped = async function (this: unknown, ...a: unknown[]) {
    const start = performance.now();
    try {
      return await orig.apply(this, a);
    } finally {
      if (recording) {
        stageMs[stage] += performance.now() - start;
        stageCalls[stage]++;
      }
    }
  };
  proto[key] = wrapped as unknown as T[keyof T];
};

const origStreamSend = StreamManager.prototype.sendEvents;
StreamManager.prototype.sendEvents = async function (
  this: StreamManager,
  ...args: Parameters<StreamManager["sendEvents"]>
) {
  const start = performance.now();
  try {
    return await origStreamSend.apply(this, args);
  } finally {
    if (recording) {
      stageMs.total += performance.now() - start;
      stageCalls.total++;
    }
  }
};
timeStage(Router.prototype, "onEventsApplied", "invalidation");

/** Outbound (non-local) fetches: a local-only path must report zero. */
interface OutboundFetch { url: string; ms: number; stack: string; }
const outbound: OutboundFetch[] = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isLocal = url.startsWith("http://localhost") || url.startsWith("http://127.");
  const start = performance.now();
  try {
    return await origFetch(input as never, init as never);
  } finally {
    if (recording && !isLocal) {
      outbound.push({
        url,
        ms: performance.now() - start,
        stack: new Error().stack?.split("\n").slice(2, 14).join("\n    ") ?? "",
      });
    }
  }
};

// ─── Boot ─────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "probe-sendevents-"));
process.env.DATA_DIR = dataDir;

_setAdminDids(["did:plc:probe-admin"]);
await stopEmbedSweeper();
await stopSearchIndexer();
closeDb();
_resetHydrationInflight();
_resetEmbedSweeper();
_resetSearchIndexer();
_resetProfileStoreCache();

openDb({ path: join(dataDir, "roomy-events.sqlite") });

const handle = await createAppserver({
  authVerifier: testAuthVerifier,
  port: 0,
  dbPath: join(dataDir, "roomy-events.sqlite"),
  readStateDbPath: join(dataDir, "roomy-readstate.sqlite"),
  quiet: true,
  // Background loops (embed sweeper, search indexer, push dispatcher) are
  // pokes off the write path, not latency: leave them off so the numbers are
  // the synchronous write path alone.
  disableBackgroundWorkers: true,
  happyView: null,
  // Production leaves `getProfiles` unset, so materialization uses the real
  // HappyView-first / Bluesky path (and writes the rows it resolves). The
  // stub keeps the probe hermetic; --production-profiles exercises the real
  // pipeline so fetch counts match production.
  ...(argv.includes("--production-profiles") ? {} : { getProfiles: async () => [] }),
});
const baseUrl = `http://localhost:${handle.port}`;

// ─── Fixture ──────────────────────────────────────────────────────────────

async function post(events: Record<string, unknown>[]): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
  if (!res.ok) throw new Error(`sendEvents ${res.status}: ${await res.text()}`);
  return performance.now() - start;
}

function messageEvents(roomId: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from(`probe message ${i}`).toString("base64") },
    },
    extensions: {},
  }));
}

const globalDb = openGlobalDb();
const spaceDb = openSpaceDb(SPACE);

await globalDb.run(
  "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
  [SPACE, SPACE],
);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
await spaceDb.run(
  `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
   values (?, ?, ?, ?)`,
  [SPACE, null, 1, 1],
);
await spaceDb.run("insert or ignore into comp_info (entity, name) values (?, ?)", [SPACE, "Probe Space"]);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, USER]);
await spaceDb.run("insert or ignore into comp_user (did, handle) values (?, ?)", [USER, null]);
await spaceDb.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [SPACE, USER]);
if (SEED_PROFILE) {
  await globalDb.run(
    "insert or replace into profiles (did, handle, name) values (?, ?, ?)",
    [USER, "probe.test", "Probe User"],
  );
}

// The room is created through a real event so every materialised column is
// populated exactly as production populates it.
const roomEvent = {
  $type: "space.roomy.room.createRoom.v0",
  id: newUlid(),
  kind: "space.roomy.channel",
  name: "probe-channel",
};
await post([roomEvent]);
const ROOM = roomEvent.id;

// ─── Measure ──────────────────────────────────────────────────────────────

// A pinger measures the blast radius: a stall local to one request must not
// show up here, a process-wide one will.
const pingLatencies: number[] = [];
let pingStop = false;
const ping = async () => {
  while (!pingStop) {
    const start = performance.now();
    try {
      await fetch(`${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}`, {
        headers: { "X-Test-Did": USER },
      });
    } catch { /* teardown */ }
    pingLatencies.push(performance.now() - start);
    await new Promise((r) => setTimeout(r, 20));
  }
};

for (let i = 0; i < WARMUP; i++) await post(messageEvents(ROOM, BATCH));

recording = true;
const pinging = ping();
const latencies: number[] = [];
const wallStart = performance.now();
for (let off = 0; off < ITERATIONS; off += CONCURRENCY) {
  const n = Math.min(CONCURRENCY, ITERATIONS - off);
  const batch = await Promise.all(Array.from({ length: n }, () => post(messageEvents(ROOM, BATCH))));
  latencies.push(...batch);
}
const wall = performance.now() - wallStart;
recording = false;
pingStop = true;
await pinging;

// ─── Report ───────────────────────────────────────────────────────────────

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
};

console.log(`\nsendEvents write-path profile — batch=${BATCH} concurrency=${CONCURRENCY} n=${latencies.length}`);
console.log(`  p50 ${pct(latencies, 50).toFixed(1)}ms   p95 ${pct(latencies, 95).toFixed(1)}ms   p99 ${pct(latencies, 99).toFixed(1)}ms`);
console.log(`  throughput ${((latencies.length / wall) * 1000).toFixed(1)} req/s (${((latencies.length * BATCH) / wall * 1000).toFixed(0)} evt/s)`);
console.log(`  concurrent getMetadata pinger: p50 ${pct(pingLatencies, 50).toFixed(1)}ms  p95 ${pct(pingLatencies, 95).toFixed(1)}ms  max ${pct(pingLatencies, 100).toFixed(1)}ms`);

const n = latencies.length;
const rttTotal = [...rttByDest.values()].reduce((a, b) => a + b, 0);
console.log(`\nDB round-trips: ${rttTotal} total, ${(rttTotal / n).toFixed(1)} per call, ${(rttTotal / n / BATCH).toFixed(1)} per event`);
for (const [dest, count] of [...rttByDest.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${dest.padEnd(10)} ${String(count).padStart(6)}  (${(count / n).toFixed(1)}/call)`);
}

console.log(`\nstage time per call (mean):`);
for (const stage of ["insert", "profiles", "applyBatch", "invalidation"] as Stage[]) {
  if (stageCalls[stage] === 0) continue;
  console.log(`    ${stage.padEnd(14)} ${(stageMs[stage] / stageCalls[stage]).toFixed(2)}ms  (${stageCalls[stage]} calls)`);
}
console.log(`    ${"TOTAL write".padEnd(14)} ${(stageMs.total / stageCalls.total).toFixed(2)}ms`);
console.log(`    ${"handler pre-write".padEnd(14)} ${(pct(latencies, 50) - stageMs.total / stageCalls.total).toFixed(2)}ms (approx, p50 minus write)`);

console.log(`\nworker time by request type:`);
for (const [type, count] of [...countByType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(20)} ${String(count).padStart(5)}  ${(msByType.get(type) ?? 0).toFixed(0)}ms total  ${((msByType.get(type) ?? 0) / count).toFixed(2)}ms mean`);
}

console.log(`\noutbound (non-local) fetches: ${outbound.length}`);
if (outbound.length > 0) {
  console.log(`  ^ the write path is supposed to be local-only; each line below is a defect`);
  for (const f of outbound.slice(0, 3)) {
    console.log(`    ${f.ms.toFixed(0)}ms  ${f.url.slice(0, 110)}`);
    console.log(`    ${f.stack}`);
  }
}

await handle.close();
closeDb();
if (KEEP) console.log(`\ndata dir kept: ${dataDir}`);
else rmSync(dataDir, { recursive: true, force: true });
