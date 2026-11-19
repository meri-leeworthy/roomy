/**
 * The query layer's session policy: what a rejected session costs a query key.
 *
 * A 401 from the session origin is a property of the session, not of the
 * question a query asked — every key gets the same answer, and it will keep
 * getting it until the token changes. So the decision belongs in the client's
 * global query defaults (`client.ts`), not in the thirty query definitions.
 *
 * TanStack spends a request in three places, and each consults the terminal
 * marks `session-health.ts` keeps:
 *
 * - `retry` decides how many times one fetch repeats. A session rejection is
 *   never repeated: the retry would carry the same dead token.
 * - `retryOnMount` decides whether a mount re-asks a query that ended in an
 *   error with nothing to show. For a marked key it does not.
 * - `refetchOnMount` decides whether a mount revalidates a query that still has
 *   data (the `staleTime: 0` views). For a marked key it does not.
 *
 * Everything else keeps TanStack's defaults: a 5xx, a timeout or a request that
 * never got a response (`status: 0`) still gets its three retries, because none
 * of them is evidence about the session. Deterministic appserver answers
 * (403/404) keep their per-query `retry: false`; that is about a question with
 * one possible answer, which is a different thing from a session that is dead.
 *
 * Free of TanStack imports so the rules are exercisable as rules.
 */

import { isSessionRejected, isSessionTerminal } from "./session-health";

/** Retries TanStack applies to a failed fetch when a query sets none. */
const RETRIES = 3;

/** The part of a TanStack query these rules read. */
export interface QueryIdentity {
  queryHash: string;
}

/**
 * Whether a fetch that just failed may be repeated. `failureCount` counts the
 * failures so far, starting at 0 for the first — the numbering TanStack's own
 * `retry: 3` uses.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isSessionRejected(error)) return false;
  return failureCount < RETRIES;
}

/** Whether a mount may ask `query` again, given what its last request cost. */
export function queryMayFetch(query: QueryIdentity): boolean {
  return !isSessionTerminal(query.queryHash);
}

/**
 * The client's query defaults, as one value: the freshness and collection rules
 * this app is built on, together with the session policy above.
 *
 * WS is the freshness authority — queries use `staleTime: Infinity`, with two
 * exceptions that set `staleTime: 0` at their own call sites: the cross-space
 * views `getActivityFeed` and `getSpaces`, for which the server pushes no frame
 * on a message-driven change (they are evicted from its response cache instead).
 * See `queries/activity-feed.ts` and `queries/spaces.ts`.
 *
 * The refetching that does happen is stale-while-revalidate: a failed refetch
 * leaves the last value the server sent in place with `status: "error"`
 * alongside it (TanStack's `isRefetchError`), so a view keeps rendering what it
 * has and guards its error branch on there being nothing to fall back on.
 * `query-health.ts` reads the same state and drives the stale-data banner.
 *
 * `gcTime` is `Infinity`: an entry nothing observes is not collected, so the
 * next snapshot still holds the rooms the user was not looking at — which are
 * exactly the entries persistence exists to keep. The six `gcTime: 0` call sites
 * (threads/links/search) keep their opt-out: they are collected the moment
 * nothing observes them, and are excluded from the persisted set structurally.
 *
 * `client.ts` installs this whole object, so a test assembling its own
 * `QueryClient` from it exercises what the app runs.
 */
export const QUERY_DEFAULTS = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: shouldRetryQuery,
  retryOnMount: queryMayFetch,
  refetchOnMount: queryMayFetch,
} as const;
