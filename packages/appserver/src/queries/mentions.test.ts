import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import type { Ulid, UserDid, StreamDid } from "@roomy-space/sdk";
import type { AppliedEvent } from "../invalidation/types.ts";
import {
  syncMentionsIndex,
  getMentionedDidsForMessage,
  getMentions,
} from "./mentions.ts";

const STREAM = "did:web:space.example" as StreamDid;
const ROOM = "01KR32FDQCCCEB8FEK76SQST9Y" as Ulid;
const MSG = "01KR32FDQCCCEB8FEK76SQST9Z" as Ulid;
const ALICE = "did:plc:alice" as UserDid;
const BOB = "did:plc:bob" as UserDid;

function makeGlobalDb(): DbLike {
  const db = new Database(":memory:");
  db.exec(
    "create table if not exists mentions (did text not null, message_id text not null, space_did text not null, room_id text not null, created_at integer not null default (unixepoch() * 1000), primary key (did, message_id)) strict",
  );
  return toAsyncDb(db);
}

function createEvent(overrides: Partial<AppliedEvent> = {}): AppliedEvent {
  return {
    type: "space.roomy.message.createMessage.v0",
    streamDid: STREAM,
    user: ALICE,
    id: MSG,
    roomId: ROOM,
    details: { mentions: [BOB] },
    ...overrides,
  } as AppliedEvent;
}

describe("mentions index", () => {
  test("syncMentionsIndex inserts a row per mentioned DID, excluding the author", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent()]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([BOB]);
  });

  test("syncMentionsIndex excludes self-mentions", async () => {
    const db = makeGlobalDb();
    // Author mentions themselves — no row.
    await syncMentionsIndex(db, [createEvent({ details: { mentions: [ALICE] } })]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([]);
  });

  test("syncMentionsIndex replaces rows on edit", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent()]);
    const carol = "did:plc:carol" as UserDid;
    await syncMentionsIndex(db, [
      createEvent({
        type: "space.roomy.message.editMessage.v0",
        details: { messageId: MSG, mentions: [carol] },
      }),
    ]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([carol]);
  });

  test("syncMentionsIndex removes rows on delete", async () => {
    const db = makeGlobalDb();
    await syncMentionsIndex(db, [createEvent()]);
    await syncMentionsIndex(db, [
      createEvent({
        type: "space.roomy.message.deleteMessage.v0",
        details: { messageId: MSG },
      }),
    ]);
    const dids = await getMentionedDidsForMessage(db, MSG);
    expect(dids).toEqual([]);
  });

  test("getMentions returns newest-first with cursor pagination", async () => {
    const db = makeGlobalDb();
    // Insert two mentions for BOB with different timestamps.
    const m1 = "01KR32FDQCCCEB8FEK76SQST9A" as Ulid;
    const m2 = "01KR32FDQCCCEB8FEK76SQST9B" as Ulid;
    await db.run(
      "insert into mentions (did, message_id, space_did, room_id, created_at) values (?, ?, ?, ?, ?)",
      [BOB, m1, STREAM, ROOM, 1000],
    );
    await db.run(
      "insert into mentions (did, message_id, space_did, room_id, created_at) values (?, ?, ?, ?, ?)",
      [BOB, m2, STREAM, ROOM, 2000],
    );

    const { mentions, cursor } = await getMentions(db, BOB, 1);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.message_id).toBe(m2); // newest first
    expect(cursor).toBeDefined();

    const page2 = await getMentions(db, BOB, 1, cursor);
    expect(page2.mentions).toHaveLength(1);
    expect(page2.mentions[0]!.message_id).toBe(m1);
    expect(page2.cursor).toBeUndefined();
  });
});
