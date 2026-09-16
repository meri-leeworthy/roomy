import { createInfiniteQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Link = typeof schemas.queries.getRoomLinks.Link.infer;

const DEFAULT_LIMIT = 20;

/**
 * Paginated, newest-first, URL-deduped index of every link shared in a single
 * room. Each link carries the room id, the message that shared it, and its
 * enriched card (absent when the embed enricher had no data).
 */
export function createRoomLinksQuery(roomId: () => string) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.room.getLinks", {
      roomId: roomId(),
    }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.room.getLinks", {
        roomId: roomId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    gcTime: 0,
  }));
}

/**
 * Paginated, newest-first, URL-deduped index of every link shared in a space,
 * filtered by the caller's read access.
 */
export function createSpaceLinksQuery(spaceId: () => string) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.space.getLinks", {
      spaceId: spaceId(),
    }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.space.getLinks", {
        spaceId: spaceId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    gcTime: 0,
  }));
}
