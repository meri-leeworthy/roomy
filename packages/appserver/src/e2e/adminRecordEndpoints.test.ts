/**
 * Admin record reads end to end: a space's events through the real write path,
 * then `getSpaceRecords` / `getSpaceRecordCounts` serving the folded set.
 *
 * The assertions are the fold's, not the event log's. The corpus below writes
 * six events that fold to three records: an edited message keeps one record
 * holding the edit, a deleted message leaves none, and `spaceInfo` — a kind the
 * feed only ever updates — appears once. Reading `record_changes` or
 * `stream_events` directly reports six changes and the pre-edit body, so
 * replacing the fold with a row scan fails these tests.
 *
 * The pagination test is the plan's acceptance (§4 P3): the cursor carries the
 * snapshot it was minted under, so a page continuation after a concurrent
 * append is exactly the records that append did not touch.
 *
 * Run: bun test --cwd packages/appserver src/e2e/adminRecordEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";

import { _setAdminDids } from "../admin.ts";
import {
  seedJoinedSpace,
  seedSpace,
  spaceDb,
  startAppserver,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:e2e-records-user";
const OTHER = "did:plc:e2e-records-other";
const ADMIN = "did:plc:e2e-records-admin";
const SPACE = "did:web:space-records.example";

_setAdminDids([ADMIN]);

/** Text content in the event's blob shape. */
function content(text: string): Record<string, unknown> {
  return {
    mimeType: "text/plain",
    data: { $bytes: Buffer.from(text, "utf8").toString("base64") },
  };
}

/**
 * Seed the space's membership directly (`createSpace` needs a PLC directory CI
 * does not have), then write every event through `sendEvents` so the feed and
 * the projection are produced by the real write path.
 */
async function seedSpaceWithRecords(ctx: E2eContext): Promise<{
  roomId: string;
  editedId: string;
  deletedId: string;
}> {
  seedSpace(ctx.db, SPACE, USER, { allowPublicJoin: 1 });
  seedJoinedSpace(ctx.db, USER, SPACE);
  await spaceDb(ctx.db, SPACE).run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, USER],
  );

  const roomId = newUlid();
  const editedId = newUlid();
  const deletedId = newUlid();

  // The write path validates each event against the projection as it stands,
  // so the room has to land before anything names it.
  const room = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: roomId,
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name: "general",
          },
        ],
      }),
    },
  );
  if (room.status !== 200) {
    throw new Error(
      `seedSpaceWithRecords: createRoom ${room.status}: ${await room.text()}`,
    );
  }

  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: editedId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: content("before edit"),
            extensions: {},
          },
          {
            id: deletedId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: content("deleted"),
            extensions: {},
          },
          {
            id: newUlid(),
            $type: "space.roomy.message.editMessage.v0",
            room: roomId,
            messageId: editedId,
            body: content("after edit"),
          },
          {
            id: newUlid(),
            $type: "space.roomy.message.deleteMessage.v0",
            room: roomId,
            messageId: deletedId,
          },
          // The adapter never emits `create` for this kind, so the fold's
          // upsert is what makes the record exist at all.
          {
            id: newUlid(),
            $type: "space.roomy.space.updateSpaceInfo.v0",
            name: "Records Space",
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `seedSpaceWithRecords: sendEvents ${res.status}: ${await res.text()}`,
    );
  }

  return { roomId, editedId, deletedId };
}

interface ServedRecord {
  repo: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
  op: string;
}

interface RecordsPage {
  records: ServedRecord[];
  cursor?: string;
}

async function getRecords(
  ctx: E2eContext,
  query: Record<string, string | number> = {},
): Promise<RecordsPage> {
  const params = new URLSearchParams({
    space: SPACE,
    ...Object.fromEntries(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ),
  });
  const res = await ctx.authedFetch(ADMIN)(
    `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceRecords?${params}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as RecordsPage;
}

/** The message text a served record carries. */
function messageText(record: ServedRecord): string {
  const body = record.record.content as {
    data: { $bytes: string };
  };
  return Buffer.from(body.data.$bytes, "base64").toString("utf8");
}

describe("space.roomy.admin.getSpaceRecords", () => {
  test("serves the folded record set, not the change log", async () => {
    const ctx = await startAppserver();
    const { editedId, deletedId } = await seedSpaceWithRecords(ctx);

    const { records, cursor } = await getRecords(ctx);

    // Six events, six changes, three records: createRoom, two creates, an
    // edit, a delete and an update-on-absent.
    expect(records).toHaveLength(3);
    expect(cursor).toBeUndefined();

    const edited = records.find((r) => r.rkey === editedId);
    expect(edited).toBeDefined();
    expect(edited!.repo).toBe(USER);
    expect(edited!.collection).toBe("space.roomy.room.message");
    expect(edited!.record.$type).toBe("space.roomy.room.message");
    // The fold applied two changes to the key; the record holds the last one.
    expect(edited!.op).toBe("update");
    expect(messageText(edited!)).toBe("after edit");
    expect(typeof edited!.record.createdAt).toBe("string");

    // The delete removed the record rather than emitting one.
    expect(records.some((r) => r.rkey === deletedId)).toBe(false);

    const info = records.find((r) => r.collection === "space.roomy.space.info");
    expect(info).toBeDefined();
    expect(info!.repo).toBe(SPACE);
    expect(info!.rkey).toBe("self");
    expect(info!.record.name).toBe("Records Space");

    const room = records.find((r) => r.collection === "space.roomy.space.room");
    expect(room).toBeDefined();
    expect(room!.repo).toBe(SPACE);

    // Ordering is the fold's: repo, then collection, then rkey.
    const keys = records.map((r) => `${r.repo}|${r.collection}|${r.rkey}`);
    expect(keys).toEqual([...keys].sort());
  });

  test("filters by repo and by collection without narrowing the fold", async () => {
    const ctx = await startAppserver();
    const { editedId } = await seedSpaceWithRecords(ctx);

    const byRepo = await getRecords(ctx, { repo: USER });
    expect(byRepo.records).toHaveLength(1);
    expect(byRepo.records[0]!.rkey).toBe(editedId);

    const byCollection = await getRecords(ctx, {
      collection: "space.roomy.room.message",
    });
    expect(byCollection.records).toHaveLength(1);
    expect(byCollection.records[0]!.rkey).toBe(editedId);
  });

  test("pagination is stable across a concurrent append", async () => {
    const ctx = await startAppserver();
    const { roomId } = await seedSpaceWithRecords(ctx);

    const first = await getRecords(ctx, { limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.cursor).toBeDefined();

    // Append while the caller is between pages. The cursor's snapshot is older
    // than this write, so the continuation must not see it — and must not skip
    // or duplicate a record that was in the first page's snapshot.
    const laterId = newUlid();
    const appended = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: laterId,
              $type: "space.roomy.message.createMessage.v0",
              room: roomId,
              body: content("written while paging"),
              extensions: {},
            },
          ],
        }),
      },
    );
    expect(appended.status).toBe(200);

    const second = await getRecords(ctx, {
      limit: 2,
      cursor: first.cursor!,
    });
    expect(second.records).toHaveLength(1);
    expect(second.cursor).toBeUndefined();

    const paged = [...first.records, ...second.records].map((r) => r.rkey);
    expect(new Set(paged).size).toBe(3);
    expect(paged).not.toContain(laterId);

    // A fresh read sees the append.
    const fresh = await getRecords(ctx);
    expect(fresh.records).toHaveLength(4);
    expect(fresh.records.some((r) => r.rkey === laterId)).toBe(true);
  });

  test("a malformed cursor is a 400, not a silent restart", async () => {
    const ctx = await startAppserver();
    await seedSpaceWithRecords(ctx);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceRecords?space=${encodeURIComponent(SPACE)}&cursor=not-a-cursor`,
    );
    expect(res.status).toBe(400);
  });

  test("non-admin callers are refused", async () => {
    const ctx = await startAppserver();
    await seedSpaceWithRecords(ctx);

    const res = await ctx.authedFetch(OTHER)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceRecords?space=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("space.roomy.admin.getSpaceRecordCounts", () => {
  test("counts the folded set per kind and per repo", async () => {
    const ctx = await startAppserver();
    await seedSpaceWithRecords(ctx);

    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceRecordCounts?space=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(3);
    expect(body.snapshot).toBeGreaterThanOrEqual(0);
    expect(body.byKind).toEqual(
      expect.arrayContaining([
        { kind: "message", collection: "space.roomy.room.message", count: 1 },
        { kind: "room", collection: "space.roomy.space.room", count: 1 },
        { kind: "spaceInfo", collection: "space.roomy.space.info", count: 1 },
      ]),
    );
    expect(body.byRepo).toEqual(
      expect.arrayContaining([
        { repo: USER, count: 1 },
        { repo: SPACE, count: 2 },
      ]),
    );
    // Everything in this corpus has a lexicon. The tally is what a later
    // migration reads to find out what it would lose.
    expect(body.unexpressible).toEqual({ total: 0, entries: [] });
  });

  test("non-admin callers are refused", async () => {
    const ctx = await startAppserver();
    await seedSpaceWithRecords(ctx);

    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceRecordCounts?space=${encodeURIComponent(SPACE)}`,
    );
    expect(res.status).toBe(403);
  });
});
