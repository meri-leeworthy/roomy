import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { pxUnauth } from "$lib/client";

const { queryKey } = cache;

/** How many spaces the homepage's discovery strip asks for. */
const DISCOVERY_LIMIT = 24;

/**
 * Query for the spaces that may be suggested to people who are not members.
 *
 * The server applies the policy (public join, and not opted out via
 * `suggest_to_others`) — this query never filters the list, so a space whose
 * admins said no cannot appear here even if the response were ever widened.
 * The section additionally hides spaces the reader has already joined.
 *
 * Called through `pxUnauth()`: the read carries nothing per-caller, and the
 * anonymous path needs no `rpc:` OAuth scope, so discovery does not depend on
 * the HappyView client's out-of-band scope allowlist.
 */
export function createDiscoverableSpacesQuery() {
  const params = { limit: String(DISCOVERY_LIMIT) };

  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getDiscoverableSpaces", params),
    queryFn: async () =>
      (await pxUnauth()).query("space.roomy.space.getDiscoverableSpaces", params),
    // Pulled view: admins change the setting while the reader is elsewhere, so
    // a mount reissues the read rather than trusting a cached list forever.
    staleTime: 0,
    retry: false,
  }));
}
