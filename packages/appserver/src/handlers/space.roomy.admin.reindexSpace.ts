/**
 * XRPC: space.roomy.admin.reindexSpace (procedure).
 *
 * Re-index ONE space's messages into Qdrant, synchronously. Targeted repair
 * for a backfill cursor that has advanced PAST unindexed messages: the
 * background sweeper reads such a cursor as "caught up" and never revisits
 * the space, and `runSearchBackfill` would re-index the entire corpus to fix
 * one space.
 *
 * Body:
 *   { spaceId: string } — the space DID to re-index.
 *
 * The space's `search_backfill_cursor` row is cleared, then the sweep walks
 * the space's messages from the beginning until it reaches the end. Upserts
 * are idempotent (point ids are deterministic UUIDv5), so re-indexing an
 * already-indexed space is a no-op on Qdrant.
 *
 * Unlike the global `resetSearchBackfill`/`runSearchBackfill`, no other
 * space's cursor is touched — except when the Qdrant collection does not
 * exist yet: it is created empty, making every cursor stale, so all cursors
 * are cleared (the background sweeper then re-indexes them). See
 * `runSpaceBackfill` for the rationale.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { StreamDid } from "@roomy-space/sdk";
import { requireAdmin } from "../admin.ts";
import { openGlobalDb } from "../db/db.ts";
import { runSpaceBackfill, searchBackfillStats } from "../search/backfill.ts";
import { getQdrantClient } from "../search/qdrantSearch.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface ReindexSpaceBody {
  spaceId?: unknown;
  /**
   * Continue from the stored cursor instead of restarting the space. Required
   * for a space larger than one time budget: the walk stops at ~60s so the
   * request cannot overrun the proxy's response timeout, and the caller loops
   * with `resume: true` until `drained` — restarting each time would re-index
   * the same first batch forever.
   */
  resume?: unknown;
}

export const adminReindexSpaceHandler: ProcedureHandler<
  ReindexSpaceBody,
  {
    spaceId: string;
    indexed: number;
    failed: number;
    drained: boolean;
    cycles: number;
    backfilled: number;
    failedTotal: number;
    dbBackoffActive: boolean;
    errorCount: number;
    lastError: string | null;
    /** Why the last per-row upsert/encode failed (null when none). */
    lastRowError: string | null;
  }
> = async (_params: QueryParams, auth: AuthCtx, body: ReindexSpaceBody) => {
  requireAdmin(auth);

  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  // Validate the DID shape before it reaches a DB path builder.
  const spaceId = StreamDid.assert(body.spaceId);

  if (!getQdrantClient()) {
    throw new XrpcError(
      503,
      "Unavailable",
      "Message search is not configured on this server",
    );
  }

  const globalDb = openGlobalDb();

  // The space must be known to the entity→space index. Without this check a
  // typo'd DID would silently "succeed" with 0 indexed — openSpaceDb
  // resolves a per-space DB for any DID, so the walk would find no rows and
  // an operator could not tell a bad DID from a genuinely empty space.
  const known = await globalDb
    .query("select 1 as ok from entity_space where space_did = ? limit 1")
    .get<{ ok: number }>(spaceId);
  if (known === null) {
    throw new XrpcError(404, "NotFound", `Unknown space: ${spaceId}`);
  }

  if (body.resume !== undefined && typeof body.resume !== "boolean") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'resume' must be a boolean if provided",
    );
  }

  const result = await runSpaceBackfill(globalDb, spaceId, {
    resume: body.resume === true,
  });
  const stats = searchBackfillStats();
  return {
    spaceId: result.spaceDid,
    indexed: result.indexed,
    failed: result.failed,
    drained: result.drained,
    cycles: result.cycles,
    backfilled: stats.backfilled,
    failedTotal: stats.failed,
    dbBackoffActive: stats.dbBackoffActive,
    errorCount: stats.errorCount,
    lastError: stats.lastError,
    lastRowError: result.lastRowError,
  };
};
