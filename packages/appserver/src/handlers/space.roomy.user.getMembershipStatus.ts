/**
 * XRPC: space.roomy.user.getMembershipStatus (query).
 *
 * Returns the caller's Roomy Pro membership status, resolved live from
 * Polar (per-grantor TTL-cached, fail-open on outage).
 *
 * The subscription page calls this to render the current state. After a
 * Polar checkout redirect (`?checkout={CHECKOUT_ID}`) the page passes the
 * checkout ID back as the `checkout` param, which forces a non-cached
 * refresh so the new membership is visible immediately instead of up to
 * 300s of cached "not a member".
 *
 * Response:
 * {
 *   isPro: boolean,     // capacity > 0 at read time
 *   capacity: number,   // max of Pro subscription (1000) and any
 *                       // max_members feature_flag benefit; 0 when no
 *                       // valid Polar state
 *   stale: boolean,     // true when served from cache because a refresh
 *                       // failed (Polar outage) — never an unknown state
 *                       // treated as capacity 0
 *   checkedAt: number,  // epoch ms
 * }
 *
 * Polar disabled (no POLAR_ACCESS_TOKEN) → 503.
 */

import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { resolveGrantorCapacity } from "../billing/capacity.ts";

export interface GetMembershipStatusResult {
  isPro: boolean;
  capacity: number;
  stale: boolean;
  checkedAt: number;
}

export const getMembershipStatusHandler: QueryHandler<
  QueryParams,
  GetMembershipStatusResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  // A checkout ID forces a non-cached Polar refresh (the user just returned
  // from the Polar checkout flow; the TTL cache would otherwise hide the
  // new membership for up to 300s).
  const checkout = optionalString(params, "checkout");
  const force = checkout !== undefined;

  const { capacity, stale } = await resolveGrantorCapacity(userDid, { force });

  return {
    isPro: capacity > 0,
    capacity,
    stale,
    checkedAt: Date.now(),
  };
};
