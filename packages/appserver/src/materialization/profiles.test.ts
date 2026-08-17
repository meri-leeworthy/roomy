import { afterEach, describe, expect, test, mock } from "bun:test";
import {
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { ProfileViewDetailed } from "@atproto/api/dist/client/types/app/bsky/actor/defs";

import { closeDb, openDb, openGlobalDb } from "../db/db.ts";
import { defaultGetProfiles, ensureProfilesForBatch } from "./profiles.ts";
import type { DbLike } from "../db/types.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");
const DISCORD_USER = UserDid.assert("did:discord:9999");

/**
 * Set up the worker-backed global DB (the authoritative `profiles` store).
 * Phase 3: profiles live in the global `profiles` table, so these tests seed
 * and assert against the global DB rather than a monolithic materialised DB.
 */
function freshGlobal(): { globalDb: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  const globalDb = openGlobalDb();
  return { globalDb };
}

function decodedAs(
  event: Event,
  idx: number,
  user: UserDid,
): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user };
}

function profileFor(did: string, handle: string): ProfileViewDetailed {
  return {
    did,
    handle,
    displayName: `${handle} display`,
    avatar: `https://cdn.example/${handle}.png`,
  } as ProfileViewDetailed;
}

function joinSpaceEvent(): Event {
  return {
    $type: "space.roomy.space.joinSpace.v0",
    id: newUlid(),
  } as unknown as Event;
}

function createMessageEvent(authorOverride?: string): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    extensions: authorOverride
      ? {
          "space.roomy.extension.authorOverride.v0": { did: authorOverride },
        }
      : {},
  } as unknown as Event;
}

describe("ensureProfilesForBatch", () => {
  test("is a no-op when getProfiles is undefined", async () => {
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];

    await ensureProfilesForBatch(globalDb, events, undefined);

    expect(
      (await globalDb
        .query("select count(*) as count from profiles")
        .get<{ count: number }>())?.count,
    ).toBe(0);
  });

  test("is a no-op when no events trigger profile lookup", async () => {
    const { globalDb } = freshGlobal();
    // createRoom isn't a NEW_USER_SIGNAL — should not trigger fetch.
    const events = [
      decodedAs(
        {
          $type: "space.roomy.room.createRoom.v0",
          id: newUlid(),
          kind: "space.roomy.channel",
        } as unknown as Event,
        1,
        ALICE,
      ),
    ];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);
    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("fetches profiles for joinSpace authors and inserts a global profile row", async () => {
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get<{ did: string; handle: string; name: string; avatar: string }>(ALICE);
    expect(row?.did).toBe(ALICE);
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("alice.test display");
    expect(row?.avatar).toBe("https://cdn.example/alice.test.png");
  });

  test("skips DIDs we already have a global profile row for", async () => {
    const { globalDb } = freshGlobal();
    await globalDb.run(
      "insert into profiles (did, handle, name) values (?, ?, ?)",
      [ALICE, "alice.test", "alice.test display"],
    );

    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    const getProfiles = mock(async () => [profileFor(BOB, "bob.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([BOB]);
  });

  test("retries DIDs that have no global profile row (failed fetch recovery)", async () => {
    // Regression: a DID whose profile fetch previously failed has no row in
    // the global `profiles` table, so it must be retried, not skipped.
    const { globalDb } = freshGlobal();
    // NOTE: no profile row for ALICE — profile fetch previously failed.

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await globalDb
        .query("select name from profiles where did = ?")
        .get<{ name: string }>(ALICE))?.name,
    ).toBe("alice.test display");
  });

  test("filters out non-bsky DIDs (e.g. did:discord:)", async () => {
    const { globalDb } = freshGlobal();
    const events = [decodedAs(joinSpaceEvent(), 1, DISCORD_USER)];
    const getProfiles = mock(async () => [] as ProfileViewDetailed[]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(0);
  });

  test("includes authorOverride DIDs from createMessage extensions", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(createMessageEvent("did:plc:override-author"), 1, ALICE),
    ];
    const getProfiles = mock(async () => [
      profileFor(ALICE, "alice.test"),
      profileFor("did:plc:override-author", "override.test"),
    ]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    const arg = (getProfiles.mock.calls as unknown as UserDid[][][])[0]![0];
    expect(new Set(arg)).toEqual(
      new Set([ALICE, UserDid.assert("did:plc:override-author")]),
    );
  });

  test("dedupes the same DID across events", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, ALICE),
      decodedAs(joinSpaceEvent(), 3, ALICE),
    ];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
  });

  test("tolerates getProfiles returning fewer profiles than requested", async () => {
    const { globalDb } = freshGlobal();
    const events = [
      decodedAs(joinSpaceEvent(), 1, ALICE),
      decodedAs(joinSpaceEvent(), 2, BOB),
    ];
    // Bob is unresolvable — appview returned only alice.
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    expect(
      (await globalDb
        .query("select count(*) as count from profiles")
        .get<{ count: number }>())?.count,
    ).toBe(1);
  });

  test("re-fetches profiles for handle.invalid after cooldown elapses", async () => {
    const { globalDb } = freshGlobal();
    // Seed ALICE with handle.invalid and an old updated_at (past cooldown)
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      [ALICE, "handle.invalid", "alice display", Date.now() - 2 * 60 * 60 * 1000], // 2 hours ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Should have fetched despite a profile existing, because handle is stale
    expect(getProfiles).toHaveBeenCalledTimes(1);
    expect(getProfiles).toHaveBeenCalledWith([ALICE]);
    expect(
      (await globalDb
        .query("select handle from profiles where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("alice.renewed.test");
  });

  test("does NOT re-fetch handle.invalid within cooldown period", async () => {
    const { globalDb } = freshGlobal();
    // Seed ALICE with handle.invalid and a recent updated_at (within cooldown)
    await globalDb.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      [ALICE, "handle.invalid", "alice display", Date.now() - 10 * 60 * 1000], // 10 minutes ago
    );

    const events = [decodedAs(joinSpaceEvent(), 1, ALICE)];
    const getProfiles = mock(async () => [profileFor(ALICE, "alice.renewed.test")]);

    await ensureProfilesForBatch(globalDb, events, getProfiles);

    // Should NOT fetch — cooldown hasn't elapsed
    expect(getProfiles).toHaveBeenCalledTimes(0);
    expect(
      (await globalDb
        .query("select handle from profiles where did = ?")
        .get<{ handle: string }>(ALICE))?.handle,
    ).toBe("handle.invalid");
  });
});

describe("defaultGetProfiles", () => {
  const realFetch = globalThis.fetch;

  // Restore the real fetch after each test so we never leak the mock into
  // other tests in the same file/process.
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("uses the XRPC path with repeated actors= keys (not comma-joined)", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request): Promise<Response> =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ profiles: [] }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await defaultGetProfiles([ALICE, BOB]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(
      (fetchMock.mock.calls as unknown as [string][])[0]![0],
    );
    expect(url.pathname).toBe("/xrpc/app.bsky.actor.getProfiles");
    // Repeated `actors=` keys, NOT a comma-joined single value.
    expect(url.searchParams.getAll("actors")).toEqual([
      "did:plc:alice",
      "did:plc:bob",
    ]);
    expect(url.searchParams.get("actors")).toBe("did:plc:alice");
    expect([...url.searchParams.keys()]).toEqual(["actors", "actors"]);
  });

  test("chunks >25 DIDs into separate requests and concatenates results", async () => {
    const dids = Array.from({ length: 30 }, (_, i) =>
      UserDid.assert(`did:plc:user${String(i).padStart(2, "0")}`),
    );
    const fetchMock = mock(
      async (url: string | URL | Request): Promise<Response> => {
        const u = new URL(url.toString());
        const actors = u.searchParams.getAll("actors");
        // Assert the 25-actor cap is respected per request.
        expect(actors.length).toBeLessThanOrEqual(25);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profiles: actors.map((d) => ({ did: d, handle: `${d}.test` })),
          }),
        } as unknown as Promise<Response>;
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const profiles = await defaultGetProfiles(dids);

    // 30 DIDs → 25 + 5 = 2 requests.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(profiles).toHaveLength(30);
  });

  test("a failing chunk does not drop profiles from other chunks", async () => {
    const dids = Array.from({ length: 50 }, (_, i) =>
      UserDid.assert(`did:plc:u${String(i).padStart(2, "0")}`),
    );
    let call = 0;
    const fetchMock = mock(
      async (_url: string | URL | Request): Promise<Response> => {
        call++;
        // 50 DIDs / 25 = exactly 2 chunks; second chunk fails, first succeeds.
        if (call === 2) {
          return { ok: false, status: 503 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profiles: [
              { did: `did:plc:survivor-${call}`, handle: "x.test" },
            ],
          }),
        } as unknown as Promise<Response>;
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const profiles = await defaultGetProfiles(dids);

    // 2 chunks (50/25); first succeeds, second returns 503 and is skipped.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First chunk's profile survives; second chunk's failure is skipped.
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.did).toBe("did:plc:survivor-1");
  });
});

describe("global profile store (Phase 2)", () => {
  test("insertProfilesWithExtras writes the global profiles table", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    const p = profileFor(ALICE, "alice.test");
    await insertProfilesWithExtras(openDb(), [p], new Map());

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get(ALICE);
    expect(row).not.toBeNull();
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("alice.test display");
    expect(row?.avatar).toBe("https://cdn.example/alice.test.png");
  });

  test("writeSetUserProfileToGlobal updates the global profile", async () => {
    const { writeSetUserProfileToGlobal } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    await writeSetUserProfileToGlobal({
      did: BOB,
      name: "Bob",
      avatar: "https://cdn.example/bob.png",
      extensions: {
        "space.roomy.extension.discordUserOrigin.v0": { handle: "bob#1234" },
      },
    });

    const row = await globalDb
      .query("select did, handle, name, avatar from profiles where did = ?")
      .get(BOB);
    expect(row).not.toBeNull();
    expect(row?.handle).toBe("bob#1234");
    expect(row?.name).toBe("Bob");
    expect(row?.avatar).toBe("https://cdn.example/bob.png");
  });

  test("Roomy record without a handle does not clobber an existing handle", async () => {
    const { insertProfilesWithExtras } = await import("./profiles.ts");
    const { globalDb } = freshGlobal();

    // Seed a Bluesky-sourced profile with a real handle first.
    await insertProfilesWithExtras(
      openDb(),
      [profileFor(ALICE, "alice.test")],
      new Map(),
    );

    // Now a Roomy record arrives (extras present) but carries no handle —
    // Roomy profile records don't store a handle. This must NOT wipe the
    // previously-fetched handle.
    const roomyProfile = {
      did: ALICE,
      handle: "", // happyViewToProfileView yields "" when the record has no handle
      displayName: "Alice Roomy",
    } as ProfileViewDetailed;
    await insertProfilesWithExtras(
      openDb(),
      [roomyProfile],
      new Map([[ALICE, { pronouns: "she/her" }]]),
    );

    const row = await globalDb
      .query("select did, handle, name from profiles where did = ?")
      .get(ALICE);
    expect(row?.handle).toBe("alice.test");
    expect(row?.name).toBe("Alice Roomy");
  });
});
