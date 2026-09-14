/**
 * Periodic Roomy Pro members-role reconciliation loop.
 *
 * A setInterval-based sweep (unref'd, alongside the maintenance/metrics
 * timers in the appserver factory) that reconciles the Roomy Space's
 * 'Members' role against Polar's live Pro-subscriber set every
 * `PRO_MEMBERS_RECONCILE_INTERVAL_MS` (10 minutes).
 *
 * Fail-safe by construction: if Polar is unreachable / non-200 / malformed
 * (or the token lacks `subscriptions:read`), `reconcileProMembers` returns
 * `failed: true` without writing any role events. The loop never guesses a
 * subscriber set.
 *
 * No-op when Polar is not configured (`getPolar()` null).
 */

import { openReadStateDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { getPolar } from "./polar.ts";
import { reconcileProMembers } from "./proRoleReconcile.ts";
import { log } from "../log.ts";

/** Reconcile every 10 minutes. */
export const PRO_MEMBERS_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Run one periodic sweep. Returns the reconcile outcome, or `null` (not an
 * error) when Polar is not configured. A Polar outage surfaces as
 * `failed: true` — the sweep performs no role mutation in that case.
 */
export async function runProMembersReconcile(): Promise<{
  failed: boolean;
  added: number;
  removed: number;
} | null> {
  const config = getPolar();
  if (!config) {
    return null;
  }
  const writerDid = getStreamManager().ownDid;
  try {
    const result = await reconcileProMembers(
      openReadStateDb(),
      config,
      writerDid,
    );
    return {
      failed: result.failed,
      added: result.added.length,
      removed: result.removed.length,
    };
  } catch (err) {
    log.error("[pro-members] periodic reconcile failed", err instanceof Error ? err : undefined);
    throw err;
  }
}
