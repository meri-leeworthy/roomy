import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type SearchMessage = typeof schemas.queries.searchMessages.SearchMessage.infer;

/**
 * Cross-space message search (`space.roomy.search.messages` with spaceId
 * omitted). The query is only enabled once the search term is ≥3 characters
 * (the appserver rejects shorter queries).
 */
export function createSearchMessagesQuery(
  q: () => string,
  limit = 20,
) {
  return createQuery(() => {
    const term = q();
    const enabled = term.trim().length >= 3;
    return {
      queryKey: queryKey("space.roomy.search.messages", { q: term }),
      queryFn: () =>
        px().query("space.roomy.search.messages", {
          q: term,
          limit: String(limit),
        }),
      enabled,
      gcTime: 0,
    };
  });
}
