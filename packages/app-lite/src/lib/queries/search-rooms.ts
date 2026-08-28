import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type RoomSearchResult =
  typeof schemas.queries.searchRooms.RoomSearchResult.infer;

/**
 * Room name search (`space.roomy.search.rooms`): every channel and thread
 * in a space whose name matches, filtered by read access. Backs the
 * forward modal's room picker — the search term is required (the appserver
 * rejects empty), so the query stays disabled until the user types.
 */
export function createSearchRoomsQuery(
  spaceId: () => string,
  q: () => string,
  limit = 20,
) {
  return createQuery(() => {
    const term = q().trim();
    const enabled = term.length >= 1;
    return {
      queryKey: queryKey("space.roomy.search.rooms", {
        spaceId: spaceId(),
        q: term,
      }),
      queryFn: () =>
        px().query("space.roomy.search.rooms", {
          spaceId: spaceId(),
          q: term,
          limit: String(limit),
        }),
      enabled,
      // Keep the previous results rendered while a new term fetches —
      // without this, each keystroke flips isPending and the results
      // flash the loading state.
      placeholderData: keepPreviousData,
      gcTime: 0,
    };
  });
}
