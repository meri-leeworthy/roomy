/**
 * XRPC: space.roomy.admin.getSpaceRecords (query, admin-only).
 *
 * One page of the records a space's change feed currently describes, in
 * lexicon shape — the read surface for the record browser
 * (`docs/plans/record-migration.md` §4 P3/P4).
 *
 * The feed is folded on read (`queries/spaceRecords.ts`) and cached per
 * `(space, latest_event)`, so paging a space costs one ordered scan of its
 * `record_changes` partition rather than one per page. `repo` and `collection`
 * narrow what a page returns, not what is folded: a record re-homed by an edit
 * is still folded from every row that touched it.
 *
 * The cursor is opaque and carries the snapshot the page was folded under, so
 * a continuation sees the same records even after a write has moved the space
 * on. Replay it with the same `repo`/`collection` filters: the position is a
 * `(repo, collection, rkey)` in the filtered sequence.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`), matching the other
 * `space.roomy.admin.*` queries.
 */

import { requireAdmin } from "../admin.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import {
  decodeRecordCursor,
  encodeRecordCursor,
  isAfterCursor,
  loadSpaceRecordSet,
  type SpaceRecord,
} from "../queries/spaceRecords.ts";

export interface GetSpaceRecordsResult {
  records: SpaceRecord[];
  /** Present when more records follow; absent on the last page. */
  cursor?: string;
}

export const adminGetSpaceRecordsHandler: QueryHandler<
  QueryParams,
  GetSpaceRecordsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const space = requireString(params, "space");
  const repo = optionalString(params, "repo");
  const collection = optionalString(params, "collection");
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: 1000,
    default: 100,
  });
  const rawCursor = optionalString(params, "cursor");
  const cursor =
    rawCursor === undefined ? undefined : decodeRecordCursor(rawCursor);

  const set = await loadSpaceRecordSet(space, cursor?.snapshot);

  const matching = set.records.filter(
    (record) =>
      (repo === undefined || record.repo === repo) &&
      (collection === undefined || record.collection === collection) &&
      (cursor === undefined || isAfterCursor(record, cursor)),
  );

  const page = matching.slice(0, limit);
  const last = page[page.length - 1];
  if (last === undefined || matching.length <= limit) return { records: page };

  return {
    records: page,
    cursor: encodeRecordCursor({
      snapshot: set.snapshot,
      repo: last.repo,
      collection: last.collection,
      rkey: last.rkey,
    }),
  };
};
