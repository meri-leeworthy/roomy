/**
 * E2E tests for space discovery:
 *   space.roomy.space.getDiscoverableSpaces — the server-side filter
 *   space.roomy.space.getSpaces              — the `suggestToOthers` tri-state
 *
 * Run: bun test --cwd packages/appserver src/e2e/discoverableSpaces.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  startAppserver,
  seedSpace,
  seedJoinedSpace,
  seedMembership,
  globalDb,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";
import { openDb } from "../db/db.ts";
import { refreshSpaceDiscovery } from "../queries/spaceDiscovery.ts";
import { newUlid } from "@roomy-space/sdk";

const USER = "did:plc:e2e-discovery-user";

/** Seed a space and publish its discovery projection, as the boot sweep does. */
async function seedDiscoverable(
  ctx: E2eContext,
  spaceId: string,
  opts?: { allowPublicJoin?: number; suggestToOthers?: number },
): Promise<void> {
  seedSpace(ctx.db, spaceId, USER, opts);
  await refreshSpaceDiscovery(openDb(), spaceId);
}

async function discoverableIds(ctx: E2eContext, query = ""): Promise<string[]> {
  const res = await ctx.anonFetch(
    `${ctx.baseUrl}/xrpc/space.roomy.space.getDiscoverableSpaces${query}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { spaces: Array<{ id: string }> };
  return body.spaces.map((s) => s.id);
}

describe("space.roomy.space.getDiscoverableSpaces", () => {
  test("includes public spaces that are unanswered or opted in", async () => {
    const ctx = await startAppserver();
    const unanswered = "did:web:space-unanswered.example";
    const optedIn = "did:web:space-opted-in.example";

    await seedDiscoverable(ctx, unanswered, { allowPublicJoin: 1 });
    await seedDiscoverable(ctx, optedIn, {
      allowPublicJoin: 1,
      suggestToOthers: 1,
    });

    expect((await discoverableIds(ctx)).sort()).toEqual(
      [unanswered, optedIn].sort(),
    );
  });

  test("excludes opted-out, invite-only, and settings-less spaces", async () => {
    const ctx = await startAppserver();
    const optedOut = "did:web:space-opted-out.example";
    const inviteOnly = "did:web:space-invite-only.example";
    const noSettings = "did:web:space-no-settings.example";
    const publicSpace = "did:web:space-public.example";

    await seedDiscoverable(ctx, optedOut, {
      allowPublicJoin: 1,
      suggestToOthers: 0,
    });
    await seedDiscoverable(ctx, inviteOnly, {
      allowPublicJoin: 0,
      suggestToOthers: 1,
    });
    await seedDiscoverable(ctx, noSettings, { allowPublicJoin: 1 });
    await spaceDb(ctx.db, noSettings).run(
      "delete from comp_space where entity = ?",
      [noSettings],
    );
    await refreshSpaceDiscovery(openDb(), noSettings);
    await seedDiscoverable(ctx, publicSpace, { allowPublicJoin: 1 });

    expect(await discoverableIds(ctx)).toEqual([publicSpace]);
  });

  test("orders by member count and honours the limit", async () => {
    const ctx = await startAppserver();
    for (const [index, members] of [
      ["a", 1],
      ["b", 5],
      ["c", 3],
    ] as const) {
      const did = `did:web:space-${index}.example`;
      await seedDiscoverable(ctx, did, { allowPublicJoin: 1 });
      globalDb(ctx.db).run(
        `insert into space_stats (space_did, member_count) values (?, ?)
         on conflict (space_did) do update set member_count = excluded.member_count`,
        [did, members],
      );
    }

    expect(await discoverableIds(ctx)).toEqual([
      "did:web:space-b.example",
      "did:web:space-c.example",
      "did:web:space-a.example",
    ]);
    expect(await discoverableIds(ctx, "?limit=2")).toHaveLength(2);
  });

  test("opening a space's setting removes it from the list", async () => {
    // The real write path: an admin sends `updateSpaceInfo` through the
    // appserver, materialisation refreshes the projection, and the next read
    // reflects the answer.
    const ctx = await startAppserver();
    const space = "did:web:space-write-path.example";
    await seedDiscoverable(ctx, space, { allowPublicJoin: 1 });
    seedJoinedSpace(ctx.db, USER, space);
    seedMembership(ctx.db, space, USER, "admin");

    expect(await discoverableIds(ctx)).toEqual([space]);

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: space,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.space.updateSpaceInfo.v0",
              suggestToOthers: false,
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    expect(await discoverableIds(ctx)).toEqual([]);
  });

  test("answers without opening a per-space DB", async () => {
    const ctx = await startAppserver();
    for (let i = 0; i < 3; i++) {
      await seedDiscoverable(ctx, `did:web:space-open-${i}.example`, {
        allowPublicJoin: 1,
      });
    }

    const openSpaceDbs = async (): Promise<number> => {
      const res = await ctx.anonFetch(`${ctx.baseUrl}/health/pool`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        spaceWorkers: Array<{ openSpaceDbs: number }>;
      };
      return body.spaceWorkers.reduce((sum, w) => sum + w.openSpaceDbs, 0);
    };

    const before = await openSpaceDbs();
    expect(before).toBeGreaterThan(0);
    expect(await discoverableIds(ctx)).toHaveLength(3);
    expect(await openSpaceDbs()).toBe(before);
  });
});

describe("space.roomy.space.getSpaces suggestToOthers", () => {
  test("is null while unanswered, a boolean once answered, absent with no settings", async () => {
    const ctx = await startAppserver();
    const unanswered = "did:web:space-list-unanswered.example";
    const optedOut = "did:web:space-list-opted-out.example";
    const noSettings = "did:web:space-list-no-settings.example";

    for (const [did, opts] of [
      [unanswered, {}],
      [optedOut, { suggestToOthers: 0 }],
      [noSettings, {}],
    ] as const) {
      seedSpace(ctx.db, did, USER, opts);
      seedJoinedSpace(ctx.db, USER, did);
    }
    await spaceDb(ctx.db, noSettings).run(
      "delete from comp_space where entity = ?",
      [noSettings],
    );

    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      spaces: Array<{ id: string; suggestToOthers?: boolean | null }>;
    };
    const byId = new Map(body.spaces.map((s) => [s.id, s]));

    expect(byId.get(unanswered)?.suggestToOthers).toBeNull();
    expect(byId.get(optedOut)?.suggestToOthers).toBe(false);
    expect(byId.get(noSettings)).not.toHaveProperty("suggestToOthers");
  });
});
