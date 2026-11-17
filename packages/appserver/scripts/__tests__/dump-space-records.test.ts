/**
 * The dump script: its flags, its filters, and the JSONL it prints.
 *
 * The script is an inspection tool, so what it has to get right is narrow and
 * worth pinning: `--space` is required, the filters narrow the printed set
 * without changing what is folded, the order is repo/collection/rkey, and one
 * line is one record. The last test runs the script itself against a written
 * events DB, which is the path an operator takes.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { StreamDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../../src/db/syncAdapter.ts";
import {
  CORPUS_STREAM,
  CORPUS_USER,
  buildCorpus,
} from "../../src/materialization/records/corpus.ts";
import { RECORD_KINDS } from "../../src/materialization/records/recordKinds.ts";
import { writeRecordChanges } from "../../src/streams/recordChanges.ts";
import {
  parseDumpArgs,
  readSpaceRecords,
  recordLine,
} from "../dump-space-records.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "dump-space-records.ts");
const EVENTS_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "src",
  "db",
  "eventsSchema.sql",
);

const SPACE = CORPUS_STREAM as string;
const OTHER_SPACE = "did:web:other-space.example";
const MESSAGE = RECORD_KINDS.message.collection;

/** An in-memory events DB holding the corpus feed for two streams. */
async function seededDb(): Promise<Database> {
  const db = new Database(":memory:");
  db.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
  const { entries } = buildCorpus({ recordProducingOnly: true });
  await writeRecordChanges(
    toAsyncDb(db) as never,
    CORPUS_STREAM,
    entries,
  );
  // A second space's feed, which a `--space` dump must not read.
  await writeRecordChanges(
    toAsyncDb(db) as never,
    OTHER_SPACE as StreamDid,
    entries.slice(0, 2),
  );
  return db;
}

describe("parseDumpArgs", () => {
  test("defaults the events path from --data-dir and DATA_DIR", () => {
    expect(parseDumpArgs(["--space", SPACE], {})).toEqual({
      ok: true,
      value: { eventsPath: join("data", "roomy-events.sqlite"), space: SPACE },
    });
    expect(
      parseDumpArgs(["--space", SPACE, "--data-dir", "/srv/roomy"], {
        DATA_DIR: "/ignored",
      }),
    ).toEqual({
      ok: true,
      value: { eventsPath: join("/srv/roomy", "roomy-events.sqlite"), space: SPACE },
    });
    expect(
      parseDumpArgs(["--space", SPACE], { DATA_DIR: "/srv/env" }),
    ).toEqual({
      ok: true,
      value: { eventsPath: join("/srv/env", "roomy-events.sqlite"), space: SPACE },
    });
  });

  test("takes an explicit path and the filters, attached or separate", () => {
    const parsed = parseDumpArgs(
      [
        "--events=/tmp/events.sqlite",
        "--space",
        SPACE,
        "--repo",
        CORPUS_USER,
        "--collection=" + MESSAGE,
      ],
      {},
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        eventsPath: "/tmp/events.sqlite",
        space: SPACE,
        repo: CORPUS_USER,
        collection: MESSAGE,
      },
    });
  });

  test("refuses a missing space, an unknown flag and a missing value", () => {
    expect(parseDumpArgs([], {})).toEqual({
      ok: false,
      error: "--space is required",
    });
    expect(parseDumpArgs(["--space", SPACE, "--nope", "x"], {})).toEqual({
      ok: false,
      error: "unknown flag: --nope",
    });
    expect(parseDumpArgs(["--space"], {})).toEqual({
      ok: false,
      error: "--space needs a value",
    });
    expect(parseDumpArgs([SPACE], {})).toEqual({
      ok: false,
      error: `unexpected argument: ${SPACE}`,
    });
  });
});

describe("readSpaceRecords", () => {
  test("folds one space, in repo/collection/rkey order", async () => {
    const db = await seededDb();
    try {
      const records = readSpaceRecords(db, { space: SPACE });

      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.repo !== OTHER_SPACE)).toBe(true);

      const keys = records.map(
        (record) => `${record.repo} ${record.collection} ${record.rkey}`,
      );
      expect(keys).toEqual([...keys].sort());
      // The corpus's own message creates sit in their author's repo, so the dump
      // shows both kinds of repo in one space.
      expect(new Set(records.map((record) => record.repo)).size).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });

  test("the filters narrow what is printed, not what is folded", async () => {
    const db = await seededDb();
    try {
      const all = readSpaceRecords(db, { space: SPACE });
      const userMessages = readSpaceRecords(db, {
        space: SPACE,
        repo: CORPUS_USER,
        collection: MESSAGE,
      });

      expect(userMessages.length).toBeGreaterThan(0);
      expect(
        userMessages.every(
          (record) =>
            record.repo === CORPUS_USER && record.collection === MESSAGE,
        ),
      ).toBe(true);
      // A message the author edited is re-homed into their repo by the fold, so
      // filtering on that repo finds it — the fold saw the whole feed.
      expect(userMessages.some((record) => record.storedRepo !== undefined)).toBe(
        true,
      );
      const edited = userMessages.find(
        (record) => record.storedRepo !== undefined,
      )!;
      expect(edited.record).toHaveProperty("content");
      expect(all.length).toBeGreaterThan(userMessages.length);
    } finally {
      db.close();
    }
  });

  test("one line per record carries its identity and its body", async () => {
    const db = await seededDb();
    try {
      const [record] = readSpaceRecords(db, { space: SPACE });
      const line = JSON.parse(recordLine(record!));
      expect(Object.keys(line).sort()).toEqual([
        "collection",
        "record",
        "repo",
        "rkey",
      ]);
      expect(line.repo).toBe(record!.repo);
      expect(line.rkey).toBe(record!.rkey);
      expect(line.collection).toBe(record!.collection);
      expect(line.record).toEqual(record!.record as never);
    } finally {
      db.close();
    }
  });
});

describe("the script itself", () => {
  let root: string;
  let eventsPath: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dump-space-records-"));
    eventsPath = join(root, "roomy-events.sqlite");
    const db = new Database(eventsPath);
    db.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
    const { entries } = buildCorpus({ recordProducingOnly: true });
    await writeRecordChanges(
      toAsyncDb(db) as never,
      CORPUS_STREAM,
      entries,
    );
    db.close();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("prints JSONL for --space and honours --collection", async () => {
    const filter = Bun.spawnSync(
      [
        process.execPath,
        "run",
        SCRIPT,
        "--events",
        eventsPath,
        "--space",
        SPACE,
        "--collection",
        MESSAGE,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(filter.exitCode).toBe(0);
    const lines = filter.stdout.toString().trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.collection).toBe(MESSAGE);
      expect(parsed.record).toBeTypeOf("object");
    }

    const all = Bun.spawnSync(
      [process.execPath, "run", SCRIPT, "--events", eventsPath, "--space", SPACE],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(all.exitCode).toBe(0);
    expect(all.stdout.toString().trim().split("\n").length).toBeGreaterThan(
      lines.length,
    );
  });

  test("exits non-zero without --space", () => {
    const proc = Bun.spawnSync(
      [process.execPath, "run", SCRIPT, "--events", eventsPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("--space is required");
  });
});
