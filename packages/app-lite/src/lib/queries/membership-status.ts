import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/** Poll cadence while a post-checkout membership is being confirmed. */
const CHECKOUT_CONFIRM_POLL_MS = 5_000;

/**
 * How long after a checkout redirect to keep polling for the membership to
 * appear. Polar's success redirect can land before the subscription is
 * finalized, so one forced read can miss it — but the wait must end.
 */
export const CHECKOUT_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Query for the logged-in user's Roomy Pro membership status, resolved
 * live from Polar (per-grantor TTL-cached, fail-open on outage).
 *
 * Pass a `checkout` getter (from the Polar checkout redirect) to force a
 * non-cached refresh so the new membership is visible immediately.
 *
 * A single forced read can still miss a just-completed purchase, so while
 * `confirmUntil` (epoch ms, set by the caller to now + the confirmation
 * window) is in the future and the membership hasn't resolved, keep
 * re-reading — each attempt carries the `checkout` param, so every one
 * bypasses the TTL cache. Polling stops the moment `isPro` is true or the
 * window closes.
 */
export function createMembershipStatusQuery(
  checkout: () => string | undefined,
  opts: { confirmUntil?: number } = {},
) {
  return createQuery(() => {
    const checkoutId = checkout();
    return {
      queryKey: queryKey("space.roomy.user.getMembershipStatus", { checkout: checkoutId }),
      queryFn: () =>
        px().query("space.roomy.user.getMembershipStatus", {
          ...(checkoutId ? { checkout: checkoutId } : {}),
        }),
      refetchInterval: (query) =>
        !query.state.data?.isPro && Date.now() < (opts.confirmUntil ?? 0)
          ? CHECKOUT_CONFIRM_POLL_MS
          : false,
    };
  });
}
