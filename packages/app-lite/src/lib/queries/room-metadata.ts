import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Room metadata (`space.roomy.room.getMetadata`).
 *
 * `roomId` is a required XRPC param — the appserver rejects an empty one with
 * a 400. The route param it is usually derived from is non-null-asserted
 * (`page.params.room!`), so it types as `string` even while the route has not
 * populated it (e.g. the sidebar stays mounted across a room → space-index
 * navigation, where `page.params.room` is `undefined` until the rune updates).
 *
 * So the query enables itself off the id rather than trusting the caller to
 * remember: an empty `roomId` means no request. `opts.enabled` is only an
 * additional gate — it can disable the query, never force an id-less fetch.
 * Pass it a plain boolean only when the caller needs a non-reactivity-driven
 * gate; any part of it derived from reactive state must be an accessor, or it
 * freezes at first evaluation (Svelte `state_referenced_locally`).
 */
export function createRoomMetadataQuery(
  roomId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", { roomId: roomId() }),
    queryFn: () =>
      px().query("space.roomy.room.getMetadata", { roomId: roomId() }),
    // `!!roomId()` is re-evaluated by the observer on every update, so the
    // query also drops back to disabled if the id empties.
    enabled:
      !!roomId() &&
      (typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled !== false),
  }));
}
