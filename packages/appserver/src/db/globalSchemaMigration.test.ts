/**
 * Regression coverage for additive global schema upgrades.
 *
 * A v4→v5 bump previously deleted global.sqlite. Per-space cursors remained
 * current, so startup replay skipped every stream and getSpaces stayed empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "./pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "./db.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("global schema migration", () => {
  test("upgrades an older schema in place without losing membership", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const old = new Database(globalPath, { create: true });
    old.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    old.exec("drop table mentions");
    old.run("insert into global_schema_version (id, version) values (1, '4')");
    old.run(
      "insert into edges (head, tail, label) values ('did:plc:user', 'did:plc:space', 'joinedSpace')",
    );
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });

      const global = pool.global();
      const edge = await global
        .query("select 1 as n from edges where label = 'joinedSpace'")
        .get<{ n: number }>();
      const version = await global
        .query("select version from global_schema_version where id = 1")
        .get<{ version: string }>();
      const mentionsTable = await global
        .query(
          "select name from sqlite_master where type = 'table' and name = 'mentions'",
        )
        .get<{ name: string }>();

      expect(edge?.n).toBe(1);
      expect(version?.version).toBe(GLOBAL_SCHEMA_VERSION);
      expect(mentionsTable?.name).toBe("mentions");
    } finally {
      await pool.close();
    }
  });
});
