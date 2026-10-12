/**
 * Unit coverage for the backfill sweeper's space selection.
 *
 * The idle heartbeat runs this selection once a minute for the life of the
 * process, so it must read the sweeper's own tables (`search_backfill_space`
 * and `search_backfill_cursor`) and never aggregate over the entity→space
 * index, which grows with the whole corpus.
 *
 * The real global schema is applied to an in-memory DB, so the SQL under test
 * is the SQL that runs in production.
 *
 * Run: bun test --cwd packages/appserver src/search/backfill.test.ts
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { nextCursorSpace } from "./backfill.ts";

const GLOBAL_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "schema-global.sql",
);

/** In-memory global DB with the real schema, plus every SQL it is asked to run. */
function openGlobal(): { db: Database; dbLike: DbLike; queries: string[] } {
  const db = new Database(":memory:");
  db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  const inner = toAsyncDb(db);
  const queries: string[] = [];
  const dbLike: DbLike = {
    ...inner,
    query(sql: string) {
      queries.push(sql);
      return inner.query(sql);
    },
  };
  return { db, dbLike, queries };
}

function registerCandidate(db: Database, spaceDid: string): void {
  db.run("insert or ignore into search_backfill_space (space_did) values (?)", [
    spaceDid,
  ]);
}

function stampCursor(db: Database, spaceDid: string, updatedAt: number): void {
  db.run(
    "insert or replace into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
    [spaceDid, "01CURSOR", updatedAt],
  );
}

describe("nextCursorSpace", () => {
  test("picks the oldest cursor without reading entity_space", async () => {
    const { db, dbLike, queries } = openGlobal();
    registerCandidate(db, "did:web:oldest.example");
    registerCandidate(db, "did:web:newest.example");
    stampCursor(db, "did:web:oldest.example", 1_000);
    stampCursor(db, "did:web:newest.example", 2_000);
    // A space the index knows about but the sweeper has not been told about
    // must not be picked: the candidate list, not the entity→space index, is
    // what bounds the round-robin.
    db.run(
      "insert into entity_space (entity_id, space_did) values ('01ENTITY', ?)",
      ["did:web:untracked.example"],
    );
    db.run("delete from search_backfill_space where space_did = ?", [
      "did:web:untracked.example",
    ]);

    expect(await nextCursorSpace(dbLike)).toBe("did:web:oldest.example");
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) expect(sql).not.toContain("entity_space");
  });

  test("picks a space with no cursor before one that has a cursor", async () => {
    const { db, dbLike } = openGlobal();
    registerCandidate(db, "did:web:swept.example");
    registerCandidate(db, "did:web:pending.example");
    stampCursor(db, "did:web:swept.example", 1_000);

    expect(await nextCursorSpace(dbLike)).toBe("did:web:pending.example");
  });

  test("returns null when the candidate list is empty", async () => {
    const { db, dbLike } = openGlobal();
    db.run(
      "insert into entity_space (entity_id, space_did) values ('01ENTITY', ?)",
      ["did:web:index-only.example"],
    );
    db.run("delete from search_backfill_space");

    expect(await nextCursorSpace(dbLike)).toBeNull();
  });
});
