/**
 * Roomy Pro members-area role reconciliation.
 *
 * The Roomy Space (`did:plc:gnwy2zbm3hu4gfdawzxmpb2s`) has a 'Members' role
 * (`01M2EQP9VWNQ6HBSV8CT6TEVEH`) whose dedicated channel is the members
 * area. Paying Roomy Pro subscribers should hold that role; users whose
 * subscription lapses should lose it.
 *
 * This module is a RECONCILIATION SWEEP (not a Polar webhook):
 *   - Desired set = DIDs with a live Roomy Pro subscription, read from
 *     Polar's subscriptions list endpoint (filtered to the Pro product).
 *   - The sweep writes `space.roomy.role.addMemberRole.v0` for subscribers
 *     not yet granted, and `space.roomy.role.removeMemberRole.v0` for a
 *     granted DID whose subscription has lapsed.
 *   - It is idempotent: re-running with no change writes nothing.
 *   - It is fail-safe on a Polar outage: if the desired set cannot be read
 *     (unreachable / non-200 / malformed Polar), it writes NOTHING — a
 *     stale or unknown state must never be read as "no one is paying",
 *     which would mass-remove members.
 *   - It NEVER clobbers manual grants: removal only targets DIDs this sweep
 *     itself granted and tracked (see `pro_role_grants`). A manually-assigned
 *     member who is not a subscriber is left untouched.
 *
 * It is not a general solution for derived roles — that comes with the
 * permissioned-spaces / arbiter migration. This is the temporary path for
 * the Roomy Pro members area.
 */

import { StreamDid, UserDid, newUlid, parseEvent, type Event } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { log } from "../log.ts";
import {
  selectProRoleGrants,
  insertProRoleGrant,
  deleteProRoleGrant,
} from "../queries/proRoleGrants.ts";
import { listProSubscribers, type PolarConfig } from "./polar.ts";

/** The Roomy Space that holds the Pro members role. */
export const ROOMY_SPACE_DID = "did:plc:gnwy2zbm3hu4gfdawzxmpb2s";

/** The 'Members' role in the Roomy Space. */
export const MEMBERS_ROLE_ID = "01M2EQP9VWNQ6HBSV8CT6TEVEH";

/** Max role events per sendEvents batch (matches the XRPC sendEvents cap). */
export const RECONCILE_BATCH_SIZE = 50;

export interface ReconcileResult {
  /** DIDs to which addMemberRole was written this run. */
  added: string[];
  /** DIDs from which removeMemberRole was written this run. */
  removed: string[];
  /** True when Polar was unreachable and the sweep wrote nothing. */
  failed: boolean;
}

function buildRoleEvent(
  $type: "space.roomy.role.addMemberRole.v0" | "space.roomy.role.removeMemberRole.v0",
  userDid: string,
  roleId: string,
): Event | null {
  const result = parseEvent({ id: newUlid(), $type, userDid, roleId });
  if (!result.success) {
    log.error("[pro-members] failed to build role event", result.error);
    return null;
  }
  return result.data;
}

/**
 * Run one reconciliation sweep against the Roomy Space's 'Members' role.
 *
 * Role mutations are written via `StreamManager.sendEvents`, so they land in
 * the event log and materialize inline — identical to a client-issued
 * sendEvents batch. The writer attribution is `writerDid` (the appserver's
 * own DID). Writes are chunked to `RECONCILE_BATCH_SIZE` events each.
 *
 * A Polar failure (outage / non-200 / malformed / missing `subscriptions:read`
 * scope) throws — the caller (the periodic timer / admin endpoint) decides
 * how to surface it. Critically, no role mutation is performed on such a
 * failure.
 */
export async function reconcileProMembers(
  readStateDb: DbLike,
  config: PolarConfig,
  writerDid: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { added: [], removed: [], failed: false };

  // ── Desired set from Polar (fail-safe: don't guess on outage) ───────────
  let subscribers: Set<string>;
  try {
    subscribers = await listProSubscribers(config);
  } catch (err) {
    log.warn(
      "[pro-members] reconcile aborted: could not enumerate subscribers (no writes)",
      err instanceof Error ? err : undefined,
    );
    result.failed = true;
    return result;
  }

  // ── Tracked grants (DIDs this sweep has granted) ────────────────────────
  const trackedRows = await selectProRoleGrants(readStateDb);
  const tracked = new Set(trackedRows.map((r) => r.did));

  const streamDid = StreamDid.assert(ROOMY_SPACE_DID);
  const roleId = MEMBERS_ROLE_ID;
  const streamManager = getStreamManager();
  const writer = UserDid.assert(writerDid);

  // ── Adds: subscriber not yet tracked by this sweep ─────────────────────
  const toAdd: string[] = [];
  for (const did of subscribers) {
    if (tracked.has(did)) continue;
    toAdd.push(did);
  }

  // ── Removals: tracked DID whose subscription has lapsed ────────────────
  const toRemove: string[] = [];
  for (const did of tracked) {
    if (subscribers.has(did)) continue;
    toRemove.push(did);
  }

  if (toAdd.length === 0 && toRemove.length === 0) {
    return result;
  }

  // ── Write role events in bounded batches ───────────────────────────────
  const allMutations = [
    ...toAdd.map((did) => ({
      $type: "space.roomy.role.addMemberRole.v0" as const,
      userDid: did,
      roleId,
    })),
    ...toRemove.map((did) => ({
      $type: "space.roomy.role.removeMemberRole.v0" as const,
      userDid: did,
      roleId,
    })),
  ];

  try {
    for (let i = 0; i < allMutations.length; i += RECONCILE_BATCH_SIZE) {
      const chunk = allMutations.slice(i, i + RECONCILE_BATCH_SIZE);
      const events = chunk.map((m) => buildRoleEvent(m.$type, m.userDid, m.roleId));
      if (events.some((e) => e === null)) {
        throw new Error("[pro-members] failed to build a role event; aborting sweep");
      }
      await streamManager.sendEvents(
        streamDid,
        events as Event[],
        writer,
      );
    }
  } catch (err) {
    log.error("[pro-members] reconcile sendEvents failed", err instanceof Error ? err : undefined);
    throw err;
  }

  // ── Record ownership AFTER successful write ─────────────────────────────
  for (const did of toAdd) {
    await insertProRoleGrant(readStateDb, did);
    result.added.push(did);
  }
  for (const did of toRemove) {
    await deleteProRoleGrant(readStateDb, did);
    result.removed.push(did);
  }

  if (result.added.length > 0 || result.removed.length > 0) {
    log.info(
      "[pro-members] reconciled",
      { added: result.added.length, removed: result.removed.length },
    );
  }

  return result;
}
