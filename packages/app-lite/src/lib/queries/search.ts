import { createInfiniteQuery, keepPreviousData } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type SearchMessage = typeof schemas.queries.searchMessages.SearchMessage.infer;

/**
 * Cross-space message search (`space.roomy.search.messages` with spaceId
 * omitted). The query is only enabled once the search term is ≥3 characters
 * (the appserver rejects shorter queries). Cursor-paginated: each page
 * carries an opaque `cursor`; the appserver emits one trailing cursor that
 * resolves to an empty page so clients can discover the window is exhausted.
 */
export function createSearchMessagesQuery(
  q: () => string,
  limit = 20,
) {
  return createInfiniteQuery(() => {
    const term = q();
    const enabled = term.trim().length >= 3;
    return {
      queryKey: queryKey("space.roomy.search.messages", { q: term }),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        px().query("space.roomy.search.messages", {
          q: term,
          limit: String(limit),
          cursor: pageParam,
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
      enabled,
      // Keep the previous results rendered while a new term fetches — without
      // this, each keystroke flips isPending and the results flash the
      // loading state.
      placeholderData: keepPreviousData,
      gcTime: 0,
    };
  });
}
