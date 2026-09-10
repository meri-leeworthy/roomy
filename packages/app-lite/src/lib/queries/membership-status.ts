import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for the logged-in user's Roomy Pro membership status, resolved
 * live from Polar (per-grantor TTL-cached, fail-open on outage).
 *
 * Pass a `checkout` getter (from the Polar checkout redirect) to force a
 * non-cached refresh so the new membership is visible immediately.
 */
export function createMembershipStatusQuery(checkout: () => string | undefined) {
  return createQuery(() => {
    const checkoutId = checkout();
    return {
      queryKey: queryKey("space.roomy.user.getMembershipStatus", { checkout: checkoutId }),
      queryFn: () =>
        px().query("space.roomy.user.getMembershipStatus", {
          ...(checkoutId ? { checkout: checkoutId } : {}),
        }),
    };
  });
}
