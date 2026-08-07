/**
 * Statement routing for the per-space DB split (Phase 1 of
 * docs/plans/per-space-dbs.md).
 *
 * Materializer statements are opaque SQL, so the target DB is derived from
 * the statement text (plan §"Global DB writes during materialization").
 * The rule is deliberately narrow:
 *
 * - `edges` statements mentioning `'joinedSpace'` or `'leftSpace'` are the
 *   per-user membership edges written by the `JoinSpace`/`LeaveSpace`
 *   materialisers (space.roomy.space.joinSpace/leaveSpace). They
 *   live in the global DB only.
 * - Everything else — `entities`, `comp_*`, `roles`, `activity_item`,
 *   `materialization_cursor`, and all other `edges` labels (member, admin,
 *   author, link, reply, forward, ...) — lives in the per-space DB.
 *
 * The set of global-DB statements is small and stable, so text matching is
 * the pragmatic Phase 1 approach the plan calls for.
 */

/** True when the statement writes the global membership edges. */
export function isGlobalEdgeStatement(sql: string): boolean {
  if (!sql.includes("edges")) return false;
  return sql.includes("'joinedSpace'") || sql.includes("'leftSpace'");
}
