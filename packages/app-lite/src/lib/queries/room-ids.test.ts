/**
 * The reply-target guard's decision rule.
 *
 * `getMessage` rejects every entity that is not a message with
 * `400 "is not a message (no room)"`, so a reply preview must not ask about a
 * target the client can already identify as a room. The guard that shipped
 * first only recognised "the target is the room the reply lives in", which
 * missed the targets that are *other* rooms — the shape production actually
 * carried (a lobby reply targeting a thread id). These cases pin the wider
 * rule, so a regression back to the own-room-only comparison fails here. They
 * also pin the second half: an index that has not answered yet makes the
 * preview wait instead of ask, because "nothing has loaded" is not "nothing is
 * a room".
 *
 * Written against `node:test` + `node:assert` (app-lite ships no test runner of
 * its own) so the file runs under `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isIndexedRoom,
  mayAskForReplyTarget,
  scanRoomIndex,
} from "./room-ids.ts";

const LOBBY = "01KZBRQMEP2FTE079YRVDFKGTA";
const BRAMBLE = "01M2EX4PQYW94DBCX6PJVDDS7X";
const SORREL = "01M2EX4XPG4M15XB03C81M9GF2";
/** A thread of `lobby` — the target shape production carried. */
const LOBBY_THREAD = "01M32SBYQZW0SZSSFJAWKCYQSF";
const MESSAGE = "01M32TJZ0W32QBER5JN9X4JB6D";

/** A `space.roomy.space.getMetadata` response as the sidebar renders it. */
const spaceMetadata = {
  sidebar: {
    categories: [
      {
        name: "GENERAL",
        position: 0,
        channels: [
          {
            id: LOBBY,
            name: "lobby",
            defaultAccess: "readwrite",
            canRead: true,
            canWrite: true,
            unreadCount: 0,
            activeThreads: [
              {
                id: "01M32SC092DNJS14N2H2XYVBJP",
                name: "an active thread",
                canRead: true,
                canWrite: true,
                unreadCount: 0,
                activity: { latestTimestamp: null, latestMembers: [] },
              },
            ],
          },
        ],
      },
    ],
    orphans: [{ id: SORREL, name: "sorrel", defaultAccess: "read", canRead: true, canWrite: false, unreadCount: 0 }],
  },
  deletedRooms: [{ id: "01DELETEDROOM0000000000000", name: "gone" }],
};


/** An infinite query's cached data: `{ pages: [...] }`. */
const spaceThreads = {
  pages: [{ rooms: [{ id: "01SPACETHREAD0000000000000", kind: "thread" }] }],
};
const roomThreads = {
  pages: [
    { threads: [{ id: LOBBY_THREAD }, { id: "01CHANNELTHREAD00000000000" }] },
  ],
};

const NSIDS = {
  spaceMetadata: "space.roomy.space.getMetadata",
  roomMetadata: "space.roomy.room.getMetadata",
  spaceThreads: "space.roomy.space.getThreads",
  roomThreads: "space.roomy.room.getThreads",
  messages: "space.roomy.room.getMessages",
} as const;

function entry(nsid: string, data: unknown, params?: Record<string, unknown>) {
  return { queryKey: params ? [nsid, params] : [nsid], state: { data } };
}

describe("mayAskForReplyTarget", () => {
  // The case the first guard covered, kept honest: a reply whose target is the
  // room it lives in needs no cache at all.
  test("a target that IS the reply's own room is not asked about", () => {
    assert.equal(
      mayAskForReplyTarget(BRAMBLE, BRAMBLE, scanRoomIndex([])),
      false,
    );
  });

  // The defect: the target is a room, but not the reply's own. Knowable only
  // from the room listings the client holds — and under the own-room-only
  // comparison this asked, and the request 400'd.
  test("a target that is ANOTHER room is not asked about", () => {
    const index = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(mayAskForReplyTarget(SORREL, LOBBY, index), false);
  });

  // The exact production shape: a lobby reply whose target is a thread of
  // lobby. The sidebar does not list it; the channel's board does.
  test("a lobby reply targeting a lobby thread is not asked about", () => {
    const index = scanRoomIndex([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.roomThreads, roomThreads, { roomId: LOBBY }),
    ]);
    assert.equal(mayAskForReplyTarget(LOBBY_THREAD, LOBBY, index), false);
  });

  // …and the same target is unknown once the index has answered without naming
  // it, which is why this guard depends on the cache rather than the own-room
  // comparison alone.
  test("a target no listing names is asked about once the index has answered", () => {
    const index = scanRoomIndex([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.messages, [{ id: MESSAGE, replyTo: LOBBY_THREAD }], {
        roomId: LOBBY,
      }),
    ]);
    assert.equal(mayAskForReplyTarget(LOBBY_THREAD, LOBBY, index), true);
  });

  // A cold load holds no listing at all. Asking then is what turned every
  // replay of a room into a 400 for replies whose target is a room: the index
  // was empty because nothing had arrived, not because nothing is a room.
  test("nothing is asked about before the first listing arrives", () => {
    const index = scanRoomIndex([
      entry(NSIDS.messages, [{ id: MESSAGE, replyTo: LOBBY_THREAD }], {
        roomId: LOBBY,
      }),
    ]);
    assert.equal(index.ready, false);
    assert.equal(mayAskForReplyTarget(LOBBY_THREAD, LOBBY, index), false);
    assert.equal(
      mayAskForReplyTarget("01UNKNOWN000000000000000000", LOBBY, index),
      false,
    );
  });

  // The guard must never suppress a lookup that could have succeeded.
  test("a real message target is asked about", () => {
    const index = scanRoomIndex([
      entry(NSIDS.spaceMetadata, spaceMetadata),
      entry(NSIDS.spaceThreads, spaceThreads),
      // The message list holds the message itself; a message id is not a room.
      entry(NSIDS.messages, [{ id: MESSAGE, replyTo: LOBBY_THREAD }], {
        roomId: LOBBY,
      }),
    ]);
    assert.equal(mayAskForReplyTarget(MESSAGE, LOBBY, index), true);
  });

  test("an id in no listing at all is still asked about", () => {
    const index = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(
      mayAskForReplyTarget("01UNKNOWN000000000000000000", LOBBY, index),
      true,
    );
  });

  test("an empty target is not asked about", () => {
    const index = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(mayAskForReplyTarget("", LOBBY, index), false);
  });
});

describe("isIndexedRoom", () => {
  // The link-summary prefetch warms a room only when the index names it.
  test("a room the listing names is warmable", () => {
    const index = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(isIndexedRoom(LOBBY, index), true);
  });

  test("a room no listing names is not warmable", () => {
    const index = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(isIndexedRoom(LOBBY_THREAD, index), false);
  });

  // An index that holds a room-keyed query but no listing has not answered:
  // its ids are this session's rooms, not the space's. Warming on that basis is
  // the cold-load mistake in the other direction.
  test("nothing is warmable before the first listing arrives", () => {
    const index = scanRoomIndex([
      entry(NSIDS.messages, [{ id: MESSAGE }], { roomId: LOBBY }),
    ]);
    assert.equal(index.rooms.has(LOBBY), true);
    assert.equal(isIndexedRoom(LOBBY, index), false);
  });

  // A listing that never resolved has no data: it is not an answer.
  test("a listing without data does not make the index ready", () => {
    const index = scanRoomIndex([
      { queryKey: [NSIDS.spaceMetadata], state: { data: undefined } },
    ]);
    assert.equal(index.ready, false);
    assert.equal(isIndexedRoom(LOBBY, index), false);
  });
});

describe("scanRoomIndex", () => {
  test("reads channels, their active threads, and orphans from the sidebar", () => {
    const { rooms } = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(rooms.has(LOBBY), true);
    assert.equal(rooms.has("01M32SC092DNJS14N2H2XYVBJP"), true);
    assert.equal(rooms.has(SORREL), true);
  });

  // A deleted room is still a room entity, so a reply targeting one fails the
  // same way; the sidebar lists them for the restore flow.
  test("reads deleted rooms", () => {
    const { rooms } = scanRoomIndex([entry(NSIDS.spaceMetadata, spaceMetadata)]);
    assert.equal(rooms.has("01DELETEDROOM0000000000000"), true);
  });

  test("reads both board shapes: space rooms and channel threads", () => {
    const { rooms } = scanRoomIndex([
      entry(NSIDS.spaceThreads, spaceThreads),
      entry(NSIDS.roomThreads, roomThreads),
    ]);
    assert.equal(rooms.has("01SPACETHREAD0000000000000"), true);
    assert.equal(rooms.has("01CHANNELTHREAD00000000000"), true);
  });

  // Every query keyed by a room id is a room by construction — including the
  // message list, whose key is the room even though its data is messages.
  test("reads the roomId of every cached key", () => {
    const { rooms } = scanRoomIndex([
      entry(NSIDS.messages, [{ id: MESSAGE }], { roomId: BRAMBLE }),
    ]);
    assert.equal(rooms.has(BRAMBLE), true);
    assert.equal(rooms.has(MESSAGE), false);
  });

  // Payloads are per-NSID responses, so a shape change must narrow the guard
  // back to asking rather than throwing.
  test("an unexpected payload shape yields no ids instead of throwing", () => {
    const { rooms } = scanRoomIndex([
      entry(NSIDS.spaceMetadata, null),
      // A room-metadata entry is keyed by a room id: the index reads the
      // param, so a malformed body still yields that room.
      entry(NSIDS.roomMetadata, { unreadCount: "nope" }, { roomId: LOBBY }),
      entry(NSIDS.spaceThreads, { pages: [{ rooms: [null, 7, { id: 42 }] }] }),
      entry(NSIDS.roomThreads, { pages: null }),
    ]);
    assert.deepEqual([...rooms], [LOBBY]);
  });

  // A listing that resolved is an answer even when it lists nothing: the
  // index has spoken, so an absent id may be asked about.
  test("an empty listing still makes the index ready", () => {
    const index = scanRoomIndex([
      entry(NSIDS.spaceMetadata, { sidebar: { categories: [], orphans: [] } }),
    ]);
    assert.equal(index.ready, true);
    assert.equal(index.rooms.size, 0);
  });
});
