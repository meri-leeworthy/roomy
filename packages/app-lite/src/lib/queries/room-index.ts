/**
 * The room index as this client's query cache holds it.
 *
 * `room-ids.ts` owns the rule — which responses name rooms, and what follows
 * from an id's absence once the listings have answered. This module is the
 * cache side of it: one place that reads the index, so the reply preview and
 * the link-summary prefetch cannot drift into disagreeing about whether the
 * client knows a room yet.
 *
 * Two entry points, because the two callers differ: {@link readRoomIndex} is a
 * plain read for code that runs once per pass (the prefetch, which is driven by
 * the message list it already re-runs on), and {@link roomIndex} is the
 * reactive read for a Svelte effect that must re-run when the listings land.
 */

import { createSubscriber } from "svelte/reactivity";
import { queryClient } from "$lib/client";
import { isRoomIndexKey, scanRoomIndex, type RoomIndex } from "$lib/queries/room-ids";

/**
 * The index as the cache holds it right now.
 *
 * Reading it in a `$effect` does not subscribe: use {@link roomIndex} there,
 * or the effect will not re-run when a listing arrives.
 */
export function readRoomIndex(): RoomIndex {
  return scanRoomIndex(queryClient.getQueryCache().getAll());
}

/**
 * Subscribe the calling effect to changes that can change the index.
 *
 * Only room-listing arrivals and room-keyed queries are forwarded: a message
 * diff fires far more often and cannot change which ids are rooms. The
 * subscription exists only while an effect reads it — see `createSubscriber` —
 * so it costs nothing where no reply preview and no link prefetch is mounted.
 */
const subscribeToRoomChanges = createSubscriber((update) =>
  queryClient.getQueryCache().subscribe((event) => {
    const key = "query" in event ? event.query.queryKey : undefined;
    if (key && isRoomIndexKey(key)) update();
  }),
);

/**
 * The index, read reactively: an effect that calls this re-runs when a listing
 * lands or a room-keyed query changes.
 */
export function roomIndex(): RoomIndex {
  subscribeToRoomChanges();
  return readRoomIndex();
}
