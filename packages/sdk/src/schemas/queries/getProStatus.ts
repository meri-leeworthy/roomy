/**
 * Schema for `space.roomy.user.getProStatus` (query).
 *
 * Returns the caller's Roomy Pro membership status, resolved live from
 * Polar (per-grantor TTL-cached, fail-open on outage). The optional
 * `checkout` param (a Polar checkout ID, present after a checkout
 * redirect) forces a non-cached refresh so the new membership is visible
 * immediately.
 */
import { type } from "arktype";

export const NSID = "space.roomy.user.getProStatus" as const;

export const Params = type({
  /** Polar checkout ID from the checkout redirect. Forces a non-cached refresh. */
  "checkout?": "string",
});

export const Response = type({
  /** True when the caller's Polar state resolves to capacity > 0. */
  isPro: "boolean",
  /** Max of the Pro subscription (1000) and any max_members benefit; 0 when no valid state. */
  capacity: "number",
  /** True when served from cache because a Polar refresh failed (fail-open). */
  stale: "boolean",
  /** Epoch ms of the check. */
  checkedAt: "number",
});
