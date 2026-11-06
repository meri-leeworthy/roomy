/**
 * XRPC: space.roomy.admin.getSpaceRecordCounts (query, admin-only).
 *
 * The tallies the record browser's tree and its "cannot be expressed" panel
 * need (`docs/plans/record-migration.md` §4 P3): how many records a space's
 * feed folds to, split by kind and by repo, plus the records
 * `toRecordJson` refuses to state as a lexicon record (plan §3 D5) grouped by
 * collection and reason.
 *
 * Shares the fold (and its `(space, latest_event)` cache) with
 * `getSpaceRecords`, and counts the same set that endpoint pages, so a tree
 * badge and the list it opens agree. `total` is the sum of `byKind` and
 * `byRepo`; unexpressible records are outside it and counted separately.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`), matching the other
 * `space.roomy.admin.*` queries.
 */

import { requireAdmin } from "../admin.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import {
  loadSpaceRecordSet,
  type KindCount,
  type RepoCount,
  type UnexpressibleCount,
} from "../queries/spaceRecords.ts";

export interface GetSpaceRecordCountsResult {
  space: string;
  /** The `stream_state.latest_event` these counts describe. */
  snapshot: number;
  /** Expressible records: the sum of `byKind` and of `byRepo`. */
  total: number;
  byKind: readonly KindCount[];
  byRepo: readonly RepoCount[];
  /**
   * Folded records no lexicon can state — what a migration would lose as
   * records, and the number plan §3 D5 asks the community to see.
   */
  unexpressible: {
    total: number;
    entries: readonly UnexpressibleCount[];
  };
}

export const adminGetSpaceRecordCountsHandler: QueryHandler<
  QueryParams,
  GetSpaceRecordCountsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const space = requireString(params, "space");
  const set = await loadSpaceRecordSet(space);

  return {
    space,
    snapshot: set.snapshot,
    total: set.records.length,
    byKind: set.byKind,
    byRepo: set.byRepo,
    unexpressible: set.unexpressible,
  };
};
