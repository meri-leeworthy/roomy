import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  ftsMatchExpression,
  extractMessageText,
  indexMessageFts,
  removeMessageFts,
  searchMessagesFts,
} from "./messageSearch.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");

const SPACE = "did:web:space.example";
const ROOM_A = "01KR32FDQCCCEB8FEK76SQST91";
const ROOM_B = "01KR32FDQCCCEB8FEK76SQST92";
const MSG_1 = "01KR32FDQCCCEB8FEK76SQST9A";
const MSG_2 = "01KR32FDQCCCEB8FEK76SQST9B";
const MSG_3 = "01KR32FDQCCCEB8FEK76SQST9C";
const AUTHOR = "did:plc:author";

function freshDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(db);
}

/** Seed an entity + optional content + author edge, then index it. */
async function seedMessage(
  db: DbLike,
  id: string,
  room: string,
  text: string | null,
  mime: string = "text/markdown",
  author: string | null = AUTHOR,
): Promise<void> {
  await db.run(
    "insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [id, SPACE, room, id],
  );
  if (text !== null) {
    await db.run(
      `insert or replace into comp_content (entity, mime_type, data, last_edit)
       values (?, ?, ?, ?)`,
      [id, mime, new TextEncoder().encode(text), id],
    );
  }
  if (author !== null) {
    await db.run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      [author, author],
    );
    await db.run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'author')",
      [id, author],
    );
  }
  await indexMessageFts(db, id);
}

describe("ftsMatchExpression", () => {
  test("quotes each token and ANDs them implicitly", () => {
    expect(ftsMatchExpression("hello world")).toBe('"hello" "world"');
  });

  test("escapes embedded double quotes", () => {
    expect(ftsMatchExpression('say "hi"')).toBe('"say" """hi"""');
  });

  test("neutralises FTS5 operators in user input", () => {
    expect(ftsMatchExpression("foo OR bar -baz *qux")).toBe(
      '"foo" "OR" "bar" "-baz" "*qux"',
    );
  });

  test("returns empty string for whitespace-only input", () => {
    expect(ftsMatchExpression("   ")).toBe("");
  });
});

describe("extractMessageText", () => {
  test("decodes richtext blocks to plaintext", () => {
    const blocks = [
      { $type: "space.roomy.richtext.blocks#text", text: "hello" },
      { $type: "space.roomy.richtext.blocks#text", text: "world" },
    ];
    const data = new TextEncoder().encode(JSON.stringify({ blocks }));
    expect(extractMessageText("application/vnd.roomy.richtext+json", data)).toBe("hello world");
  });

  test("strips markdown from legacy text bodies", () => {
    const data = new TextEncoder().encode("**bold** [link](https://x.test) text");
    expect(extractMessageText("text/markdown", data)).toBe("bold link text");
  });

  test("returns empty for null data", () => {
    expect(extractMessageText("text/markdown", null)).toBe("");
  });

  test("returns empty for non-text non-richtext mime", () => {
    expect(extractMessageText("application/octet-stream", new TextEncoder().encode("x"))).toBe("");
  });
});

describe("searchMessagesFts", () => {
  test("returns ranked hits with snippets, filtered by room set", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "the quick brown fox");
    await seedMessage(db, MSG_2, ROOM_B, "quick fox jumps high");
    await seedMessage(db, MSG_3, ROOM_A, "nothing here");

    const hits = await searchMessagesFts(db, { q: "fox", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits.map((h) => h.entity)).toEqual([MSG_1]);
    expect(hits[0]!.room).toBe(ROOM_A);
    expect(hits[0]!.snippet).toContain("fox");
    expect(hits[0]!.rank).toBeLessThanOrEqual(0); // bm25 ranks are ≤ 0, best first
  });

  test("bm25 ranks the best match first", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "cat dog bird");
    await seedMessage(db, MSG_2, ROOM_A, "cat cat cat cat cat");

    const hits = await searchMessagesFts(db, { q: "cat", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits[0]!.entity).toBe(MSG_2);
  });

  test("empty readable room set returns no results", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "hello world");
    const hits = await searchMessagesFts(db, { q: "hello", roomIds: [], limit: 10, offset: 0 });
    expect(hits).toEqual([]);
  });

  test("rooms outside the readable set are excluded", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "hello world");
    await seedMessage(db, MSG_2, ROOM_B, "hello world");
    const hits = await searchMessagesFts(db, { q: "hello", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits.map((h) => h.entity)).toEqual([MSG_1]);
  });

  test("supports offset pagination", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "alpha beta");
    await seedMessage(db, MSG_2, ROOM_A, "alpha gamma");
    await seedMessage(db, MSG_3, ROOM_A, "alpha delta");

    const page1 = await searchMessagesFts(db, { q: "alpha", roomIds: [ROOM_A], limit: 2, offset: 0 });
    expect(page1.map((h) => h.entity)).toEqual([MSG_1, MSG_2]);

    const page2 = await searchMessagesFts(db, { q: "alpha", roomIds: [ROOM_A], limit: 2, offset: 2 });
    expect(page2.map((h) => h.entity)).toEqual([MSG_3]);
  });
});

describe("indexMessageFts / removeMessageFts", () => {
  test("edit re-indexes: delete-then-insert keeps a single row", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "old content");
    await db.run(
      `update comp_content set data = ? where entity = ?`,
      [new TextEncoder().encode("new content"), MSG_1],
    );
    await indexMessageFts(db, MSG_1);

    const oldHits = await searchMessagesFts(db, { q: "old", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(oldHits).toEqual([]);
    const newHits = await searchMessagesFts(db, { q: "new", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(newHits.map((h) => h.entity)).toEqual([MSG_1]);
  });

  test("empty content drops the message from the index", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "   ");
    const hits = await searchMessagesFts(db, { q: "hello", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits).toEqual([]);
  });

  test("message without a room is not indexed", async () => {
    const db = freshDb();
    await db.run("insert into entities (id, stream_id) values (?, ?)", [MSG_1, SPACE]);
    await db.run(
      `insert into comp_content (entity, mime_type, data, last_edit)
       values (?, 'text/markdown', ?, ?)`,
      [MSG_1, new TextEncoder().encode("hello world"), MSG_1],
    );
    await indexMessageFts(db, MSG_1);
    const hits = await searchMessagesFts(db, { q: "hello", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits).toEqual([]);
  });

  test("removeMessageFts drops the row", async () => {
    const db = freshDb();
    await seedMessage(db, MSG_1, ROOM_A, "hello world");
    await removeMessageFts(db, MSG_1);
    const hits = await searchMessagesFts(db, { q: "hello", roomIds: [ROOM_A], limit: 10, offset: 0 });
    expect(hits).toEqual([]);
  });
});
