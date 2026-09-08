/**
 * Bridge-token capacity resolution from Polar customer state.
 *
 * Shared by the grant/revoke procedures and the admin getSpaceMembership
 * endpoint. Per-grantor Polar state is TTL-cached (see billing/polar.ts);
 * on Polar outage the last-known-valid cached state is served with a stale
 * flag — never an unknown treated as capacity 0.
 */

import { XrpcError } from "../xrpc/errors.ts";
import {
  getCachedCustomerState,
  getPolar,
  resolveCapacity,
  PolarUnavailableError,
  type PolarConfig,
} from "./polar.ts";

export interface GrantorCapacity {
  /** Summed capacity of the grantor's currently-valid Polar state. */
  capacity: number;
  /** True when the state was served from cache because a refresh failed. */
  stale: boolean;
}

/**
 * Resolve a grantor's current bridge-token capacity from Polar.
 *
 * - Polar disabled (no token configured) → 503.
 * - No valid state → capacity 0 (not an error; the caller decides what 0
 *   means — e.g. grant rejection "not a Pro member").
 * - Polar outage AND no cached state → 503.
 */
export async function resolveGrantorCapacity(
  grantorDid: string,
): Promise<GrantorCapacity> {
  const config = getPolar();
  if (!config) {
    throw new XrpcError(
      503,
      "ServiceUnavailable",
      "Polar billing is not configured",
    );
  }
  return resolveGrantorCapacityWith(config, grantorDid);
}

/**
 * Same as `resolveGrantorCapacity`, but with an explicit config (unit
 * tests / callers that already hold the singleton).
 */
export async function resolveGrantorCapacityWith(
  config: PolarConfig,
  grantorDid: string,
): Promise<GrantorCapacity> {
  try {
    const { state, stale } = await getCachedCustomerState(grantorDid, config);
    const { capacity } = resolveCapacity(
      state ?? { active_subscriptions: [], granted_benefits: [] },
      config,
    );
    return { capacity, stale };
  } catch (err) {
    if (err instanceof PolarUnavailableError) {
      throw new XrpcError(
        503,
        "ServiceUnavailable",
        "Polar is unavailable and no cached state exists",
      );
    }
    throw err;
  }
}
