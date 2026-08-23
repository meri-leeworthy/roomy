/**
 * Background data preloading.
 *
 * Two tiers, both fire-and-forget from the UI:
 *
 * 1. `preloadSpaceSidebars()` — after auth completes, prefetch the sidebar
 *    (`getSpaceMetadata`) for every joined space. When the user opens a space
 *    the sidebar renders from cache instead of a cold fetch.
 *
 * 2. `preloadRoomMessages(spaceId)` — when a space is open and its sidebar is
 *    loaded, prefetch the first page of `getMessages` for every readable room
 *    in that space. Navigating into a room then renders instantly.
 *
 * Why `ensureQueryData` and not SvelteKit preload hooks: all app data lives in
 * the TanStack cache (`staleTime: Infinity`, WS is the sole freshness
 * authority — see `client.ts`). `data-sveltekit-preload-data="hover"` only
 * covers SvelteKit `load` data, which this app doesn't use for room data.
 * `ensureQueryData` returns immediately on a cache hit and only fetches on a
 * miss, so re-running these on navigation/metadata updates is free for
 * already-prefetched entries — and the WS `#messageDiff`/`#roomMetadataDiff`
 * patchers keep prefetched entries live (they already tolerate absent entries).
 *
 * Concurrency is bounded (4 in flight) so a space with many rooms doesn't
 * fan out into an appserver request spike (see the prefetch-link-summaries
 * note about cold-cache fan-out).
 */

import { cache } from "@roomy-space/sdk";
import { queryClient } from "$lib/client";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

const GET_SPACES = "space.roomy.space.getSpaces";
const SPACE_METADATA = "space.roomy.space.getMetadata";
const GET_MESSAGES = "space.roomy.room.getMessages";

const MESSAGES_LIMIT = "50";
const CONCURRENCY = 4;

/** Run `fn` over `items` with at most `CONCURRENCY` in flight. Best-effort. */
async function withConcurrency<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    async () => {
      while (i < items.length) {
        const item = items[i++];
        if (item === undefined) break;
        try {
          await fn(item);
        } catch {
          // Best-effort: a failed prefetch must never break the caller.
        }
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Prefetch the sidebar (`getSpaceMetadata`) for every joined space.
 * Call once after auth completes; idempotent via `ensureQueryData`.
 */
export async function preloadSpaceSidebars(): Promise<void> {
  const spaces = await queryClient.ensureQueryData({
    queryKey: queryKey(GET_SPACES, { includeLeft: "true" }),
    queryFn: () => px().query(GET_SPACES, { includeLeft: "true" }),
  });
  const joined = spaces.spaces.filter((s) => s.isMember);
  await withConcurrency(joined, (space) =>
    queryClient.ensureQueryData({
      queryKey: queryKey(SPACE_METADATA, { spaceId: space.id }),
      queryFn: () => px().query(SPACE_METADATA, { spaceId: space.id }),
    }),
  );
}

/**
 * Prefetch the first page of messages for every readable room in a space.
 * Call when the space is open and its sidebar is available; idempotent via
 * `ensureQueryData` (cache hits return immediately, so re-running on sidebar
 * updates only fetches newly-appeared rooms).
 */
export async function preloadRoomMessages(spaceId: string): Promise<void> {
  const meta = await queryClient.ensureQueryData({
    queryKey: queryKey(SPACE_METADATA, { spaceId }),
    queryFn: () => px().query(SPACE_METADATA, { spaceId }),
  });

  const rooms = new Set<string>();
  const collect = (channels: readonly {
    id: string;
    canRead: boolean;
    activeThreads?: readonly { id: string; canRead: boolean }[];
  }[]) => {
    for (const ch of channels) {
      if (ch.canRead) rooms.add(ch.id);
      for (const t of ch.activeThreads ?? []) {
        if (t.canRead) rooms.add(t.id);
      }
    }
  };
  collect(meta.sidebar.categories.flatMap((c) => c.channels));
  collect(meta.sidebar.orphans);

  await withConcurrency([...rooms], (roomId) =>
    queryClient.ensureQueryData({
      queryKey: queryKey(GET_MESSAGES, { roomId }),
      queryFn: async () => {
        const res = await px().query(GET_MESSAGES, {
          roomId,
          limit: MESSAGES_LIMIT,
        });
        return res.messages;
      },
    }),
  );
}
