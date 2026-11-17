/**
 * Global `space_discovery` — the cross-space projection that answers
 * `space.roomy.space.getDiscoverableSpaces`.
 *
 * Whether a space may be suggested to people who are not members is decided by
 * two columns of its OWN per-space DB: `comp_space.suggest_to_others` (NULL =
 * admins have not answered, which reads as suggested; 0 = opted out) and
 * `comp_space.allow_public_join` (NULL = unset, which reads as public). Deriving
 * the answer per request meant opening every space's DB, so this module keeps
 * both values precomputed in the global DB instead, and the read path touches
 * one small table plus the member-count aggregate it orders by.
 *
 * Same split as `spaceStats.ts`: one function reads the two columns out of a
 * space DB and writes the global row (`writeSpaceDiscovery`, used by
 * `applyBatch`, which holds both handles), and one recomputes it from a router
 * handle (`refreshSpaceDiscovery`, used by the boot sweep).
 *
 * A row is written for every space that has a `comp_space` row, INCLUDING an
 * unanswered one (both columns NULL), because "unanswered" is a real state the
 * read path treats as discoverable. A missing row means the space has no
 * `comp_space` row at all — it has no settings to read and is not discoverable.
 */

import type { DbLike } from "../db/types.ts";

/** The two settings, as stored (both NULLABLE, per the per-space schema). */
export interface SpaceDiscoveryRow {
  allow_public_join: number | null;
  suggest_to_others: number | null;
}

/**
 * Copy one space's discovery settings into the global projection.
 *
 * `spaceDb` is that space's own DB and `globalDb` the global one; they live on
 * different pool workers, so the caller passes both rather than reaching
 * through a router handle. A space with no `comp_space` row gets its projection
 * row deleted: without settings there is nothing to discover it by.
 */
export async function writeSpaceDiscovery(
  globalDb: DbLike,
  spaceDb: DbLike,
  spaceDid: string,
): Promise<void> {
  const row = await spaceDb
    .query(
      `select allow_public_join, suggest_to_others
         from comp_space
        where entity = ?`,
    )
    .get<SpaceDiscoveryRow>(spaceDid);

  if (row === null) {
    await globalDb.run("delete from space_discovery where space_did = ?", spaceDid);
    return;
  }

  await globalDb.run(
    `insert into space_discovery
       (space_did, allow_public_join, suggest_to_others, updated_at)
     values (?, ?, ?, ?)
     on conflict (space_did) do update set
       allow_public_join = excluded.allow_public_join,
       suggest_to_others = excluded.suggest_to_others,
       updated_at = excluded.updated_at`,
    spaceDid,
    row.allow_public_join,
    row.suggest_to_others,
    Date.now(),
  );
}

/**
 * Recompute and store one space's projection row, given a handle that can reach
 * both that space's DB and the global DB (e.g. the `openDb()` router).
 */
export async function refreshSpaceDiscovery(
  db: DbLike,
  spaceDid: string,
): Promise<void> {
  const spaceDb = db.forSpace?.(spaceDid);
  const globalDb = db.global?.();
  if (!spaceDb || !globalDb) return;
  await writeSpaceDiscovery(globalDb, spaceDb, spaceDid);
}

/**
 * Space DIDs eligible for discovery, most populated first.
 *
 * Eligible means: public join (`allow_public_join` is NULL or 1) AND not opted
 * out (`suggest_to_others` is NULL or 1). The filter is here, on the server, so
 * no client can surface a space that opted out, and the ordering runs in SQL
 * over two small global tables (`space_discovery`, `space_stats`) rather than
 * in the caller's memory.
 */
export async function selectDiscoverableSpaces(
  globalDb: DbLike,
  limit: number,
): Promise<string[]> {
  const rows = await globalDb
    .query(
      `select sd.space_did as did
         from space_discovery sd
         left join space_stats ss on ss.space_did = sd.space_did
        where coalesce(sd.suggest_to_others, 1) = 1
          and coalesce(sd.allow_public_join, 1) = 1
        order by coalesce(ss.member_count, 0) desc, sd.space_did asc
        limit ?`,
    )
    .all<{ did: string }>(limit);
  return rows.map((r) => r.did);
}
