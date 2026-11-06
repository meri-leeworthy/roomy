/**
 * RSS soak: drive sustained read+write XRPC load across many spaces and record
 * the process's memory series.
 *
 * Seeds `SPACES` spaces (each one room with `MESSAGES_PER_SPACE` messages) into
 * `DATA_DIR`, boots the real appserver over that data, then runs `CONCURRENCY`
 * request loops until `DURATION_MIN` elapses. One CSV row per `SAMPLE_SEC`:
 * RSS and its parts, open SQLite file descriptors, and every worker's
 * open-connection / prepared-statement counts.
 *
 *   DATA_DIR=/tmp/rss-soak/data OUT=/tmp/rss-soak/rss.csv \
 *     bun perf/rss-soak.ts
 *
 * Env:
 *   SPACES=1200 MESSAGES_PER_SPACE=40 CONCURRENCY=8 DURATION_MIN=40
 *   SAMPLE_SEC=10 SEED=1 WRITE_EVERY=10 HEAP_SNAPSHOTS=1 SKIP_SEED=0
 *
 * The DB bounds come from the appserver's own env: APPSERVER_DB_POOL_SIZE,
 * APPSERVER_MAX_SPACE_DBS, APPSERVER_SPACE_DB_CACHE_KIB and
 * APPSERVER_SPACE_DB_CACHE_BUDGET_KIB. RATE_LIMIT_DISABLED=true and
 * APPSERVER_TEST_MODE=true are required for sustained load: the per-IP limiter
 * allows 100 requests a minute.
 */
import { appendFileSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newUlid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import {
  closeDb,
  openDb,
  openGlobalDb,
  openReadStateDb,
  openSpaceDb,
  poolStats,
} from "../src/db/db.ts";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const SPACES = Number(env("SPACES", "1200"));
const MESSAGES_PER_SPACE = Number(env("MESSAGES_PER_SPACE", "40"));
const CONCURRENCY = Number(env("CONCURRENCY", "8"));
const DURATION_MIN = Number(env("DURATION_MIN", "40"));
const SAMPLE_SEC = Number(env("SAMPLE_SEC", "10"));
const WRITE_EVERY = Number(env("WRITE_EVERY", "10"));
const OUT = env("OUT", "/tmp/rss-soak/rss.csv");
const HEAP_SNAPSHOTS = env("HEAP_SNAPSHOTS", "1") === "1";
/** Reuse the spaces a previous run seeded into the same `DATA_DIR`. */
const SKIP_SEED = env("SKIP_SEED", "0") === "1";

const USER = "did:plc:rss-soak-user";

interface SeededSpace {
  spaceId: string;
  roomId: string;
}

/** One deterministic pseudo-random stream, so a run is repeatable. */
let seedState = Number(env("SEED", "1")) >>> 0;
const rand = () => {
  seedState = (seedState * 1664525 + 1013904223) >>> 0;
  return seedState / 0x100000000;
};

const didFor = (prefix: string, i: number) => `did:plc:${prefix}${i.toString(36)}`;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * A 26-character Crockford-base32 id, ascending with `i` (so it is a valid
 * ULID the write path accepts). Deterministic so a re-run against the same
 * DATA_DIR addresses the rows a previous run seeded (see `SKIP_SEED`).
 */
const idFor = (prefix: string, i: number) => {
  let digits = "";
  let n = i;
  do {
    digits = CROCKFORD[n % 32]! + digits;
    n = Math.floor(n / 32);
  } while (n > 0);
  return `${prefix}${digits.padStart(26 - prefix.length, "0")}`;
};

/** Bytes SQLite reports as held: open `*.sqlite`, `-wal` and `-shm` descriptors. */
const sqliteFds = () => {
  let count = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`).includes(".sqlite")) count++;
    } catch {
      /* the entry raced its close */
    }
  }
  return count;
};

const mib = (bytes: number) => (bytes / 1048576).toFixed(2);

async function seed(): Promise<SeededSpace[]> {
  if (SKIP_SEED) {
    return Array.from({ length: SPACES }, (_, i) => ({
      spaceId: didFor("soakspace", i),
      roomId: idFor("01JR", i),
    }));
  }
  const global = openGlobalDb();
  const readState = openReadStateDb();
  const spaces: SeededSpace[] = [];
  const started = Date.now();

  for (let i = 0; i < SPACES; i++) {
    const spaceId = didFor("soakspace", i);
    const roomId = idFor("01JR", i);
    const db = openSpaceDb(spaceId);

    const steps: Array<{
      type: "query" | "run" | "exec";
      sql: string;
      params?: unknown[];
    }> = [];
    const run = (sql: string, params: unknown[]) =>
      steps.push({ type: "run", sql, params });
    run("insert or ignore into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
    run(
      `insert or ignore into comp_space
         (entity, allow_public_join, allow_member_invites, suggest_to_others)
       values (?, ?, ?, ?)`,
      [spaceId, 0, 1, null],
    );
    run("insert or ignore into comp_info (entity, name) values (?, ?)", [spaceId, `Soak Space ${i}`]);
    run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, USER]);
    run("insert or ignore into comp_user (did, handle) values (?, ?)", [USER, "soak.test"]);
    run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [spaceId, USER]);
    run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [USER, spaceId]);
    run("insert or ignore into entities (id, stream_id) values (?, ?)", [roomId, spaceId]);
    run("insert or ignore into comp_room (entity, label) values (?, ?)", [roomId, "space.roomy.channel"]);

    const msgIds: string[] = [];
    for (let m = 0; m < MESSAGES_PER_SPACE; m++) {
      const msgId = idFor("01JT", i * 1000 + m);
      msgIds.push(msgId);
      run("insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
        msgId,
        spaceId,
        roomId,
        msgId,
      ]);
      run(
        `insert or ignore into comp_content (entity, mime_type, data, last_edit)
         values (?, 'text/html', ?, ?)`,
        [msgId, new TextEncoder().encode(`<p>soak message ${i}/${m}</p>`), msgId],
      );
    }

    for (let start = 0; start < steps.length; start += 200) {
      await db.transaction(steps.slice(start, start + 200));
    }

    const indexSteps: Array<{
      type: "query" | "run" | "exec";
      sql: string;
      params?: unknown[];
    }> = [
      {
        type: "run",
        sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
        params: [spaceId, spaceId],
      },
      {
        type: "run",
        sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
        params: [roomId, spaceId],
      },
    ];
    for (const msgId of msgIds) {
      indexSteps.push({
        type: "run",
        sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
        params: [msgId, spaceId],
      });
    }
    for (let start = 0; start < indexSteps.length; start += 200) {
      await global.transaction(indexSteps.slice(start, start + 200));
    }

    await readState.run(
      `insert into user_space_membership
         (user_did, space_did, state, source, source_event_id)
       values (?, ?, 'joined', 'seed', ?)
       on conflict(user_did, space_did) do update set state = excluded.state`,
      [USER, spaceId, `01SEED${i.toString(36)}`],
    );

    spaces.push({ spaceId, roomId });
    if ((i + 1) % 200 === 0) {
      console.log(`# seeded ${i + 1}/${SPACES} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }
  return spaces;
}

/** Milliseconds the in-flight sample window's `getMessages` calls took. */
let messageLatencies: number[] = [];

/** POST to an XRPC query; returns the status code (the soak wants load, not bodies). */
async function get(baseUrl: string, path: string): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { "X-Test-Did": USER } });
  await res.arrayBuffer();
  return res.status;
}

/** Nearest-rank quantile of an unsorted sample. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

async function writeMessage(baseUrl: string, space: SeededSpace): Promise<number> {
  const res = await fetch(`${baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
    body: JSON.stringify({
      spaceId: space.spaceId,
      events: [
        {
          id: newUlid(),
          $type: "space.roomy.message.createMessage.v0",
          room: space.roomId,
          body: {
            mimeType: "text/plain",
            data: { $bytes: Buffer.from(`soak ${Date.now()}`).toString("base64") },
          },
          extensions: {},
        },
      ],
    }),
  });
  await res.arrayBuffer();
  return res.status;
}

const main = async () => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    "ts,rss_mib,heap_used_mib,heap_total_mib,external_mib,array_buffers_mib,sqlite_fds," +
      "space_open_dbs,space_prepared_stmts,worker_heap_mib,worker_external_mib,cache_size," +
      "p50_ms,p95_ms,ok,err\n",
  );

  console.log(
    `# pool=${env("APPSERVER_DB_POOL_SIZE", "8")} ` +
      `maxSpaceDbs=${env("APPSERVER_MAX_SPACE_DBS", "derived")} ` +
      `cacheKib=${env("APPSERVER_SPACE_DB_CACHE_KIB", "512")} spaces=${SPACES} ` +
      `concurrency=${CONCURRENCY} duration=${DURATION_MIN}min`,
  );

  openDb();
  await openSpaceDb("did:plc:warmup").query("select 1 as x").get();
  const spaces = await seed();

  const handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    quiet: true,
  });
  const baseUrl = `http://localhost:${handle.port}`;

  if (HEAP_SNAPSHOTS) {
    writeFileSync(`${OUT}.heap0.heapsnapshot`, new Uint8Array(Bun.generateHeapSnapshot("v8", "arraybuffer")));
  }

  let ok = 0;
  let err = 0;
  let writes = 0;
  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MIN * 60_000;
  let running = true;

  const loops = Array.from({ length: CONCURRENCY }, async (_, workerIndex) => {
    let iteration = 0;
    while (running && Date.now() < deadline) {
      const space = spaces[Math.floor(rand() * spaces.length)]!;
      try {
        const feed = await get(
          baseUrl,
          `/xrpc/space.roomy.space.getActivityFeed?spaceId=${encodeURIComponent(space.spaceId)}`,
        );
        const startedRequest = performance.now();
        const messages = await get(
          baseUrl,
          `/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(space.roomId)}&limit=50`,
        );
        messageLatencies.push(performance.now() - startedRequest);
        if (feed === 200 && messages === 200) ok++;
        else err++;
        if (iteration % WRITE_EVERY === workerIndex % WRITE_EVERY) {
          if ((await writeMessage(baseUrl, space)) === 200) writes++;
          else err++;
        }
      } catch {
        err++;
      }
      iteration++;
    }
  });

  let sample = 0;
  const sampler = setInterval(async () => {
    const mem = process.memoryUsage();
    const stats = await poolStats();
    const workers = stats
      ? [stats.globalWorker, stats.readStateWorker, stats.eventsWorker, ...stats.spaceWorkers]
      : [];
    const openDbs = workers.reduce((sum, w) => sum + w.openSpaceDbs, 0);
    const stmts = workers.reduce((sum, w) => sum + w.preparedStmts, 0);
    const workerHeap = workers.reduce((sum, w) => sum + w.heapUsed, 0) / 1048576;
    const workerExternal = workers.reduce((sum, w) => sum + w.external, 0) / 1048576;
    const cacheSize = handle.queryCache?.stats.size ?? 0;
    const p50 = quantile(messageLatencies, 0.5);
    const p95 = quantile(messageLatencies, 0.95);
    messageLatencies = [];
    sample++;
    appendFileSync(
      OUT,
      `${new Date().toISOString()},${mib(mem.rss)},${mib(mem.heapUsed)},${mib(mem.heapTotal)},` +
        `${mib(mem.external)},${mib(mem.arrayBuffers)},${sqliteFds()},${openDbs},${stmts},` +
        `${workerHeap.toFixed(2)},${workerExternal.toFixed(2)},${cacheSize},` +
        `${p50.toFixed(2)},${p95.toFixed(2)},${ok},${err}\n`,
    );
    if (sample % 6 === 0) {
      console.log(
        `# t+${((Date.now() - startedAt) / 60000).toFixed(1)}min rss=${mib(mem.rss)}MiB fds=${sqliteFds()} ` +
          `open=${openDbs} workerHeap=${workerHeap.toFixed(1)}MiB cache=${cacheSize} ` +
          `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
          `ok=${ok} err=${err} writes=${writes}`,
      );
    }
  }, SAMPLE_SEC * 1000);

  await Promise.all(loops);
  running = false;
  clearInterval(sampler);

  if (HEAP_SNAPSHOTS) {
    writeFileSync(`${OUT}.heap1.heapsnapshot`, new Uint8Array(Bun.generateHeapSnapshot("v8", "arraybuffer")));
  }

  const elapsedMin = (Date.now() - startedAt) / 60000;
  const final = process.memoryUsage();
  console.log(
    `# done ${elapsedMin.toFixed(1)}min rss=${mib(final.rss)}MiB ok=${ok} err=${err} writes=${writes}`,
  );

  await handle.close();
  closeDb();
};

await main();
