/**
 * The fold: what the change feed describes, as records.
 *
 * Two halves. The first pins the rules the feed's shape forces — an update is an
 * upsert, a patch merges one level, a delete removes, and an edit lands in the
 * repo that holds the record it touches — with rows built by hand so each rule
 * is visible on its own. The second is the acceptance evidence for the whole
 * thing: the corpus applied through `applyBatch` produces a projection, its
 * change feed folded through here has to describe the same messages, rooms and
 * memberships.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { StreamDid } from "@roomy-space/sdk";

import { closeDb, openDb } from "../../db/db.ts";
import { toAsyncDb } from "../../db/syncAdapter.ts";
import type { DbLike } from "../../db/types.ts";
import { applyBatch } from "../applyBatch.ts";
import type { LoggedEvent } from "../types.ts";
import {
  CORPUS_RECEIVED_AT,
  CORPUS_STREAM,
  CORPUS_USER,
  buildCorpus,
  type Fixture,
} from "./corpus.ts";
import { RECORD_KINDS } from "./recordKinds.ts";
import { foldChanges, type FoldedRecord } from "./foldChanges.ts";
import {
  readRecordChanges,
  writeRecordChanges,
  type RecordChangeRow,
} from "../../streams/recordChanges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "..", "db", "schema-global.sql");
const EVENTS_SCHEMA_PATH = join(__dirname, "..", "..", "db", "eventsSchema.sql");

const SPACE = "did:plc:fold-space";
const AUTHOR = "did:plc:fold-author";
const ADMIN = "did:plc:fold-admin";
const MESSAGE = RECORD_KINDS.message.collection;

let seq = 0;

/** One feed row, in the shape `writeRecordChanges` writes and the fold reads. */
function row(
  repo: string,
  collection: string,
  rkey: string,
  op: RecordChangeRow["op"],
  body: unknown,
  actor: string = repo,
): RecordChangeRow {
  const idx = ++seq;
  return {
    streamId: SPACE,
    idx,
    ord: 0,
    kind: "message",
    repo,
    collection,
    rkey,
    op,
    // 26 characters, the stamp's length; the fold only orders by the log's own
    // `(idx, ord)` and copies this value to its output.
    orderStamp: String(idx).padStart(26, "0"),
    actor,
    eventId: `event-${idx}`,
    body: op === "delete" ? null : JSON.stringify(body),
  };
}

describe("the fold's rules", () => {
  test("an update with no record creates it", () => {
    const records = foldChanges([
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "a space",
      }),
    ]);

    expect(records).toEqual([
      {
        repo: SPACE,
        collection: RECORD_KINDS.spaceInfo.collection,
        rkey: "self",
        record: { name: "a space" },
        orderStamp: records[0]!.orderStamp,
        ops: 1,
      },
    ]);
  });

  test("a patch merges one level, not into nested objects", () => {
    const records = foldChanges([
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "before",
        allowPublicJoin: true,
      }),
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "after",
        allowPublicJoin: null,
      }),
    ]);

    expect(records[0]!.record).toEqual({
      name: "after",
      allowPublicJoin: null,
    });
    expect(records[0]!.ops).toBe(2);

    const nested = foldChanges([
      row(AUTHOR, MESSAGE, "m1", "create", { content: { mime: "a" }, room: "r1" }),
      row(AUTHOR, MESSAGE, "m1", "update", { content: { mime: "b" } }, AUTHOR),
    ]);
    // The patch replaces `content`; it does not add `mime` to the old object.
    expect(nested[0]!.record).toEqual({ content: { mime: "b" }, room: "r1" });
  });

  test("a delete removes the record, and a delete of nothing is nothing", () => {
    const removed = foldChanges([
      row(AUTHOR, MESSAGE, "m1", "create", { room: "r1" }),
      row(SPACE, MESSAGE, "m1", "delete", null, AUTHOR),
    ]);
    expect(removed).toEqual([]);

    const noop = foldChanges([row(SPACE, MESSAGE, "m1", "delete", null, ADMIN)]);
    expect(noop).toEqual([]);
  });

  test("an author's edit is re-homed to the author's repo", () => {
    const records = foldChanges([
      row(AUTHOR, MESSAGE, "m1", "create", { room: "r1", body: "first" }),
      row(SPACE, MESSAGE, "m1", "update", { body: "second" }, AUTHOR),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]!.repo).toBe(AUTHOR);
    expect(records[0]!.storedRepo).toBe(SPACE);
    expect(records[0]!.record).toEqual({ room: "r1", body: "second" });
    expect(records[0]!.ops).toBe(2);
  });

  test("an admin's edit stays in the space repo and leaves the author's alone", () => {
    const records = foldChanges([
      row(AUTHOR, MESSAGE, "m1", "create", { room: "r1", body: "first" }),
      row(SPACE, MESSAGE, "m1", "update", { body: "curated" }, ADMIN),
    ]);

    const byRepo = new Map(records.map((record) => [record.repo, record]));
    expect(byRepo.get(AUTHOR)!.record).toEqual({ room: "r1", body: "first" });
    expect(byRepo.get(SPACE)!.record).toEqual({ body: "curated" });
    // The row's own repo is where the change went, so nothing was re-homed.
    expect(byRepo.get(SPACE)!.storedRepo).toBeUndefined();
  });

  test("rows apply in the order given, so the last write wins", () => {
    const rows = [
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "one",
      }),
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "two",
      }),
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {
        name: "three",
      }),
    ];
    const records = foldChanges(rows);

    expect(records).toHaveLength(1);
    expect(records[0]!.record).toEqual({ name: "three" });
    expect(records[0]!.orderStamp).toBe(rows[2]!.orderStamp);
    expect(records[0]!.ops).toBe(3);
  });

  test("records come back ordered by repo, then collection, then key", () => {
    const records = foldChanges([
      row(SPACE, MESSAGE, "m2", "create", {}),
      row(AUTHOR, MESSAGE, "m1", "create", {}),
      row(SPACE, RECORD_KINDS.spaceInfo.collection, "self", "update", {}),
      row(AUTHOR, MESSAGE, "m0", "create", {}),
    ]);

    expect(
      records.map((record) => `${record.repo} ${record.collection} ${record.rkey}`),
    ).toEqual([
      `${AUTHOR} ${MESSAGE} m0`,
      `${AUTHOR} ${MESSAGE} m1`,
      `${SPACE} ${MESSAGE} m2`,
      `${SPACE} ${RECORD_KINDS.spaceInfo.collection} self`,
    ]);
  });

  test("a body that is not a record is an error naming the row", () => {
    const broken = row(SPACE, MESSAGE, "m1", "create", null);
    expect(() =>
      foldChanges([{ ...broken, body: "not json" }]),
    ).toThrow(/m1 body is not JSON/);
    expect(() => foldChanges([{ ...broken, body: '["a"]' }])).toThrow(
      /m1 body is not a record/,
    );
  });
});

// ── the corpus: the fold against the projection ────────────────────────────

const STREAM = CORPUS_STREAM as string;

beforeEach(() => {
  // `applyBatch`'s side-effect path opens the read-state DB through the worker.
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

/**
 * A space DB built from the corpus by the write path, its change feed written to
 * an events DB, and both handles back for comparison.
 */
async function buildSpaceAndFeed(): Promise<{
  space: Database;
  folded: FoldedRecord[];
  entries: LoggedEvent[];
  fx: Fixture;
}> {
  const { entries, fx } = buildCorpus({ recordProducingOnly: true });

  const space = new Database(":memory:");
  space.exec("pragma foreign_keys = on");
  space.exec(readFileSync(SCHEMA_PATH, "utf8"));
  space.run(
    "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
    [STREAM, STREAM, CORPUS_RECEIVED_AT, CORPUS_RECEIVED_AT],
  );
  space.run(
    "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
    [STREAM, CORPUS_RECEIVED_AT, CORPUS_RECEIVED_AT],
  );

  const global = new Database(":memory:");
  global.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  const stats = await applyBatch(
    toAsyncDb(space) as DbLike,
    STREAM as StreamDid,
    entries,
    { isBackfill: false },
    toAsyncDb(global),
  );
  global.close();
  if (stats.applyErrors > 0 || stats.materializerErrors > 0) {
    throw new Error(
      `corpus: ${stats.applyErrors} apply / ${stats.materializerErrors} materialiser errors`,
    );
  }

  // The feed is written and read back through the DB, so the corpus test covers
  // the row encoding as well as the fold.
  const events = new Database(":memory:");
  events.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
  await writeRecordChanges(toAsyncDb(events) as DbLike, STREAM as StreamDid, entries);
  const rows = await readRecordChanges(toAsyncDb(events), STREAM, 0, 1_000_000);
  events.close();

  return { space, folded: foldChanges(rows), entries, fx };
}

describe("the corpus, folded", () => {
  test("describes the messages the materialiser wrote", async () => {
    const { space, folded, entries } = await buildSpaceAndFeed();
    try {
      const messages = folded.filter(
        (record) => record.collection === MESSAGE,
      );
      const foldedKeys = new Set(messages.map((record) => record.rkey));

      // The projection's messages: an entity in a room with a content row, plus
      // every forward reference, which carries no content of its own.
      const projected = space
        .query<{ id: string }, []>(
          `select e.id as id
             from entities e
             join comp_content c on c.entity = e.id
            where e.room is not null
           union
           select head as id from edges where label = 'forward'`,
        )
        .all()
        .map((row) => row.id);
      // A join writes an announcement message from the membership change alone,
      // so no message record produces it — the one key the fold cannot describe.
      const announcements = new Set(
        entries
          .filter((entry) => entry.event.$type === "space.roomy.space.joinSpace.v0")
          .map((entry) => String(entry.event.id)),
      );
      const expected = new Set(
        projected.filter((id) => !announcements.has(id)),
      );

      expect(messages.length).toBe(expected.size);
      expect([...foldedKeys].sort()).toEqual([...expected].sort());

      // Content agrees byte for byte, for every message that carries one.
      const content = new Map(
        space
          .query<{ entity: string; mime_type: string; data: Uint8Array }, []>(
            "select entity, mime_type, data from comp_content",
          )
          .all()
          .map((row) => [row.entity, row]),
      );
      let compared = 0;
      for (const message of messages) {
        const body = message.record.content as
          | { mimeType: string; data: { $bytes: string } }
          | undefined;
        if (body === undefined) continue;
        const stored = content.get(message.rkey)!;
        expect(stored.mime_type).toBe(body.mimeType);
        expect(Buffer.from(stored.data).toString("base64")).toBe(
          body.data.$bytes,
        );
        compared++;
      }
      // The creates that survive the log's edits and deletes: three minus the
      // deleted one, both edited bodies included.
      expect(compared).toBe(2);
    } finally {
      space.close();
    }
  });

  test("describes the rooms and the memberships the materialiser wrote", async () => {
    const { space, folded } = await buildSpaceAndFeed();
    try {
      const rooms = folded
        .filter((record) => record.collection === RECORD_KINDS.room.collection)
        .map((record) => record.rkey)
        .sort();
      const projectedRooms = space
        .query<{ entity: string }, []>("select entity from comp_room")
        .all()
        .map((row) => row.entity)
        .sort();
      expect(rooms).toEqual(projectedRooms);

      const members = folded
        .filter(
          (record) => record.collection === RECORD_KINDS.membership.collection,
        )
        .map((record) => record.rkey)
        .sort();
      const projectedMembers = space
        .query<{ tail: string }, [string]>(
          "select tail from edges where head = ? and label = 'member'",
        )
        .all(STREAM)
        .map((row) => row.tail)
        .sort();
      expect(members).toEqual(projectedMembers);
      expect(members.length).toBeGreaterThan(0);
    } finally {
      space.close();
    }
  });

  test("re-homes the corpus's own edits and leaves every other write where it was stored", async () => {
    const { folded, fx } = await buildSpaceAndFeed();

    const rehomed = folded.filter((record) => record.storedRepo !== undefined);
    // The move and the edit are the feed's only writes by an author to their own
    // record; each lands beside the create instead of in the space repo.
    expect(rehomed.map((record) => record.rkey).sort()).toEqual(
      [fx.kept, fx.edited].sort(),
    );
    for (const record of rehomed) {
      expect(record.repo).toBe(CORPUS_USER);
      expect(record.storedRepo).toBe(STREAM);
      expect(record.ops).toBe(2);
    }

    // The forward is the author's own create and is never written again, so it
    // stays in their repo with nothing to re-home.
    const forwards = folded.filter(
      (record) => record.record.forwardOf !== undefined,
    );
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.repo).toBe(CORPUS_USER);
    expect(forwards[0]!.storedRepo).toBeUndefined();
  });
});
