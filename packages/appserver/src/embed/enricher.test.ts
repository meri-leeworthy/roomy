import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { toAsyncDb } from "../db/syncAdapter.ts";
import {
  storeEmbedData,
  findPendingLinks,
  filterPendingUrls,
  fetchEmbedData,
  countPendingLinks,
  type PendingLink,
} from "./enricher.ts";
import type { DbLike } from "../db/types.ts";
import type { Embed } from "./types.ts";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");
const SCHEMA_VERSION = "10-appserver.4";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

/** In-memory global DB (schema-global.sql) for the pending_links index tests. */
function freshGlobalDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(GLOBAL_SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  return { db, asyncDb: toAsyncDb(db) };
}

/** Insert the entity + comp_embed_link rows needed for a URL to be enrichable. */
function seedLink(db: Database, url: string): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    url,
    "did:web:test.example",
  ]);
  db.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
    url,
  ]);
}

/** Insert a row into the global pending_links index. */
function seedPendingLink(
  db: Database,
  url: string,
  spaceDid = "did:web:test.example",
  messageId = "msg1",
  createdAt = Date.now(),
): void {
  db.run(
    "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
    [spaceDid, messageId, url, createdAt],
  );
}

type DataRow = {
  embed_json: string | null;
  attempts: number;
  retry_after: number | null;
};
function dataRow(db: Database, url: string): DataRow | null {
  const row = db
    .query<DataRow, [string]>(
      "select embed_json, attempts, retry_after from comp_embed_link_data where entity = ?",
    )
    .get(url);
  return row ?? null;
}

const EMBED: Embed = { v: "1", ts: "x", ty: "link", t: "T" };

describe("embed retry-with-backoff (per-space storeEmbedData)", () => {
  test("transient failure schedules a retry with escalating backoff", async () => {
    const { db, asyncDb } = freshDb();
    seedLink(db, "https://a.example");

    // First transient failure: attempts=1, retry_after ~1m in the future.
    await storeEmbedData(asyncDb, "https://a.example", { status: "transient" });
    let row = dataRow(db, "https://a.example")!;
    expect(row.attempts).toBe(1);
    expect(row.retry_after).not.toBeNull();
    expect((row.retry_after ?? 0) > Date.now()).toBe(true); // in the future
    const firstRetry = row.retry_after!;

    // Second transient failure: attempts=2, backoff escalates (later retry).
    await storeEmbedData(asyncDb, "https://a.example", { status: "transient" });
    row = dataRow(db, "https://a.example")!;
    expect(row.attempts).toBe(2);
    expect((row.retry_after ?? 0) > firstRetry).toBe(true);
  });
  test("definitive failure (404 / no-data) settles with no retry", async () => {
    const { db, asyncDb } = freshDb();
    seedLink(db, "https://c.example");
    await storeEmbedData(asyncDb, "https://c.example", { status: "definitive" });
    const row = dataRow(db, "https://c.example")!;
    expect(row.embed_json).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
  });

  test("success stores embed data and clears any prior retry state", async () => {
    const { db, asyncDb } = freshDb();
    seedLink(db, "https://d.example");
    // Fail transiently first (sets attempts + retry_after), then succeed.
    await storeEmbedData(asyncDb, "https://d.example", { status: "transient" });
    await storeEmbedData(asyncDb, "https://d.example", { status: "ok", embed: EMBED });
    const row = dataRow(db, "https://d.example")!;
    expect(row.embed_json).not.toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.retry_after).toBeNull();
  });

  test("filterPendingUrls (priority) only returns never-attempted links", async () => {
    const { db, asyncDb } = freshDb();
    seedLink(db, "https://new.example");
    seedLink(db, "https://failed.example");
    await storeEmbedData(asyncDb, "https://failed.example", { status: "transient" });
    const got = await filterPendingUrls(asyncDb, [
      "https://new.example",
      "https://failed.example",
    ]);
    // Priority is for freshly-detected (never-attempted) links only — a
    // transiently-failed URL already has a data row (with a future retry_after)
    // and must wait for its backoff via the backlog, not jump the queue again.
    expect(got).toContain("https://new.example");
    expect(got).not.toContain("https://failed.example");
  });
});

describe("global pending_links index (findPendingLinks / countPendingLinks)", () => {
  test("findPendingLinks returns pending rows oldest-first with space + message", async () => {
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://old.example", "did:web:a", "m1", 1000);
    seedPendingLink(db, "https://new.example", "did:web:b", "m2", 2000);

    const pending = await findPendingLinks(asyncDb);
    expect(pending.map((p) => p.url)).toEqual([
      "https://old.example",
      "https://new.example",
    ]);
    expect(pending[0]).toMatchObject({
      url: "https://old.example",
      spaceDid: "did:web:a",
      messageId: "m1",
    });
    expect(pending[1]).toMatchObject({
      url: "https://new.example",
      spaceDid: "did:web:b",
      messageId: "m2",
    });
  });

  test("findPendingLinks respects the limit", async () => {
    const { db, asyncDb } = freshGlobalDb();
    seedPendingLink(db, "https://one.example", "did:web:a", "m1", 1000);
    seedPendingLink(db, "https://two.example", "did:web:a", "m2", 2000);
    seedPendingLink(db, "https://three.example", "did:web:a", "m3", 3000);

    const pending = await findPendingLinks(asyncDb, 2);
    expect(pending.map((p) => p.url)).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  test("countPendingLinks counts all pending rows", async () => {
    const { db, asyncDb } = freshGlobalDb();
    expect(await countPendingLinks(asyncDb)).toBe(0);
    seedPendingLink(db, "https://one.example", "did:web:a", "m1");
    seedPendingLink(db, "https://two.example", "did:web:b", "m2");
    expect(await countPendingLinks(asyncDb)).toBe(2);
    expect(await countPendingLinks(asyncDb)).toBe((await findPendingLinks(asyncDb)).length);
  });
});

describe("fetchEmbedData status classification", () => {
  // The embed service is reached at EMBED_SERVICE_URL (default
  // embed.internal.weird.one); stub fetch so no real network call is made.
  const realFetch = globalThis.fetch;

  function stubStatus(status: number, statusText = "", body = ""): void {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(body, { status, statusText }),
      )) as typeof globalThis.fetch;
  }

  function withStub<T>(fn: () => Promise<T>): Promise<T> {
    return fn().finally(() => {
      globalThis.fetch = realFetch;
    });
  }

  test("400/401/403 are definitive (no retry) — sites that block scrapers settle", async () => {
    // Regression: these used to be `transient`, so bsky.app's permanent 400
    // and eprint.iacr.org's permanent 403 were retried forever (backoff caps
    // at 6h), keeping a permanent backlog and a permanent log flood.
    for (const status of [400, 401, 403, 404, 410]) {
      stubStatus(status, "blocked");
      const result = await withStub(() => fetchEmbedData("https://x.example"));
      expect(result).toEqual({ status: "definitive" });
    }
  });

  test("429 and 5xx are transient (retry later)", async () => {
    for (const status of [429, 500, 502, 503]) {
      stubStatus(status);
      const result = await withStub(() => fetchEmbedData("https://x.example"));
      expect(result).toEqual({ status: "transient" });
    }
  });

  test("200 with a payload is ok", async () => {
    const embed: Embed = { v: "1", ts: "x", ty: "link", t: "T" };
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(["x", embed]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof globalThis.fetch;
    const result = await withStub(() => fetchEmbedData("https://x.example"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.embed).toEqual(embed);
    globalThis.fetch = realFetch;
  });

  test("200 with a null payload is definitive", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(["x", null]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof globalThis.fetch;
    const result = await withStub(() => fetchEmbedData("https://x.example"));
    expect(result).toEqual({ status: "definitive" });
    globalThis.fetch = realFetch;
  });
});