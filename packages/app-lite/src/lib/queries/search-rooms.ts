import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type RoomSearchResult =
  typeof schemas.queries.searchRooms.RoomSearchResult.infer;

/**
 * Room name search (`space.roomy.search.rooms`): every channel and thread
 * in a space whose name matches, filtered by read access. Backs the
 * forward modal's room picker and the "Rooms & threads" section of the
 * search results page. The endpoint requires a spaceId and a non-empty
 * term, so the query stays disabled until both are available (the
 * directory search has no space to scope room results to).
 */
export function createSearchRoomsQuery(
  spaceId: () => string | undefined,
  q: () => string,
  limit = 20,
) {
  return createQuery(() => {
    const sid = spaceId();
    const term = q().trim();
    // The endpoint requires a spaceId and a non-empty term; the query stays
    // disabled until both are available (the directory search has no space
    // to scope room results to).
    const enabled = sid !== undefined && term.length >= 1;
    return {
      queryKey: queryKey("space.roomy.search.rooms", {
        spaceId: sid,
        q: term,
      }),
      queryFn: () =>
        px().query("space.roomy.search.rooms", {
          spaceId: sid!,
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
