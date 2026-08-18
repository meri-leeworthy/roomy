/**
 * Per-request membership hydration.
 *
 * Before a caller-scoped read can be answered, we need to know which spaces
 * the caller has joined. Membership is tracked as `joinedSpace` edges with
 * `head = userDid`, written by the `JoinSpace` materialisation and by the
 * join/create handlers directly.
 *
 * Membership edges live in the GLOBAL DB (they're cross-space data), so
 * hydration reads the intended spaces from the global DB.
 *
 * Per-user dedup: concurrent calls for the same userDid share an in-flight
 * promise to avoid N parallel membership reads.
 */

import type { DbLike } from "../db/types.ts";
import { type StreamDid, type UserDid } from "@roomy-space/sdk";
import { openReadStateDb } from "../db/db.ts";
import { selectJoinedSpaceDids } from "../queries/userSpaceMembership.ts";

export interface HydrationFailure {
  streamDid: StreamDid;
  reason: string;
}

export interface UserHydrationResult {
  /** Space DIDs the user has joined and not left. */
  intendedSpaceDids: StreamDid[];
  /** Spaces that failed to materialise (network, DB unreachable, etc.). Logged, not thrown. */
  hydrationFailures: HydrationFailure[];
}

export interface HydrateOpts {
  db?: DbLike;
}

const inflight = new Map<UserDid, Promise<UserHydrationResult>>();

export function hydrateUserMembership(
  userDid: UserDid,
  opts: HydrateOpts = {},
): Promise<UserHydrationResult> {
  const existing = inflight.get(userDid);
  if (existing) return existing;

  const promise = run(userDid, opts).finally(() => {
    inflight.delete(userDid);
  });
  inflight.set(userDid, promise);
  return promise;
}

async function run(
  userDid: UserDid,
  opts: HydrateOpts,
): Promise<UserHydrationResult> {
  const db = opts.db ?? openReadStateDb();

  // Materialization is handled by the subscription system. We read whatever
  // state is currently materialised and return it. If backfill is still in
  // progress the returned membership may be partial; the client will see a
  // complete view once the materializer finishes and invalidation signals
  // arrive.
  const intendedSpaceDids = await readIntendedSpaceDids(db, userDid);

  const hydrationFailures: HydrationFailure[] = [];

  return { intendedSpaceDids, hydrationFailures };
}

/**
 * Read the user's intended (joined-and-not-left) spaces from the durable
 * read-state `user_space_membership` table. This is the authoritative source
 * during the transition to ATProto permission records; the global `joinedSpace`
 * edges are no longer read for membership intent.
 */
async function readIntendedSpaceDids(
  db: DbLike,
  userDid: UserDid,
): Promise<StreamDid[]> {
  return selectJoinedSpaceDids(db, userDid);
}

/** Test helper. */
export function _resetHydrationInflight(): void {
  inflight.clear();
}
