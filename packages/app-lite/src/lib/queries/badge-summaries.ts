/**
 * The badge summary lookups, and the policy that bounds them.
 *
 * `SpaceRoomBadge` renders an avatar and a label for one internal link, so it
 * needs one summary row per space and room it names. Those lookups belong to
 * the client — they are XRPC queries through the authenticated client, and
 * they land in the shared TanStack cache alongside every other query — while
 * the badge itself is presentational and takes them as props. This module is
 * the appside of that seam.
 *
 * ## Why a failed key is never re-asked
 *
 * A link can name a space or room the appserver holds no row for (a stale
 * link, a link to another deployment), which 404s deterministically. A badge
 * sits in a message row of the virtualized list, so scrolling recycles it and
 * every re-entry into the room remounts it. Asking an unanswerable lookup once
 * per mount turned one stale link into a request per scroll. The guard here —
 * an errored key resolves `undefined` without a request — bounds each key to
 * at most one attempt per session, and the prefetcher shares it (it calls the
 * same functions).
 */

import { cache } from "@roomy-space/sdk";
import type {
  RoomSummaryResolver,
  SpaceSummaryResolver,
} from "@roomy/design/components/content/thread/message/embeds/types.ts";
import { queryClient } from "$lib/client";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

const SPACE_SUMMARY = "space.roomy.space.getSpaceSummary";
const ROOM_SUMMARY = "space.roomy.room.getRoomSummary";

/**
 * Resolve one summary, or `undefined` when it cannot be answered.
 *
 * `ensureQueryData` returns immediately on a cache hit and joins an in-flight
 * request for the same key, so every badge naming the same target shares one
 * round-trip. `retry: false` states the intent: a "not found" never becomes
 * true by asking again. (Transport-level retries, which cover rate limits,
 * live in `DirectXrpcClient`.)
 */
async function summaryOrUndefined<T>(
  key: readonly unknown[],
  queryFn: () => Promise<unknown>,
): Promise<T | undefined> {
  if (queryClient.getQueryState(key)?.status === "error") return undefined;
  try {
    return (await queryClient.ensureQueryData({
      queryKey: key,
      queryFn,
      retry: false,
    })) as T;
  } catch {
    // Unanswerable — absent, unreadable, or signed out. The badge renders its
    // fallback label rather than failing the row it sits in.
    return undefined;
  }
}

/** The display fields of a space named by an internal link. */
export const resolveSpaceSummary: SpaceSummaryResolver = (spaceId) =>
  summaryOrUndefined(
    queryKey(SPACE_SUMMARY, { spaceId }),
    () => px().query(SPACE_SUMMARY, { spaceId }),
  );

/** The display fields of a room named by an internal link. */
export const resolveRoomSummary: RoomSummaryResolver = (roomId) =>
  summaryOrUndefined(
    queryKey(ROOM_SUMMARY, { roomId }),
    () => px().query(ROOM_SUMMARY, { roomId }),
  );
