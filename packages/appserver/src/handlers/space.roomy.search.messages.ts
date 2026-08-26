/**
 * XRPC: space.roomy.search.messages (query).
 *
 * Per-space full-text message search (SQLite FTS5), filtered by the caller's
 * read access. Results are hydrated via selectMessages so the response shape
 * matches the shared Message schema.
 *
 * Supports cursor-based pagination via `limit` and `cursor` (an opaque
 * offset token).
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { searchMessagesFts } from "../queries/messageSearch.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { MessageDto } from "../queries/selectMessages.ts";

interface SearchMessagesResult {
  messages: MessageDto[];
  cursor?: string;
}

export const searchMessagesHandler: QueryHandler<
  QueryParams,
  SearchMessagesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");
  const q = requireString(params, "q");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;

  if (q.trim().length < 3) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Param q must be at least 3 characters",
    );
  }

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openSpaceDb(spaceId);
  // Per-request memo: every room in this space shares the same space-level
  // membership/admin/ban flags — without the memo, each roomAccess call
  // re-queries them (~5 queries × N rooms).
  const memo = createAccessMemo();
  await requireSpaceRead(db, spaceId, userDid, memo);

  // Pre-filter by the caller's readable room set (the plan's recommendation
  // for per-space search): enumerate every non-deleted room in the space and
  // keep the ones the caller can read, then restrict the FTS query to those.
  const allRooms = await db
    .query(
      `select e.id as id
         from entities e
         join comp_room cr on cr.entity = e.id
        where e.stream_id = ?
          and coalesce(cr.deleted, 0) = 0`,
    )
    .all<{ id: string }>([spaceId]);

  const readable: string[] = [];
  for (const r of allRooms) {
    const acc = await roomAccess(db, r.id, userDid, memo);
    if (acc.canRead) readable.push(r.id);
  }

  const offset = cursor !== null ? Number(cursor) : 0;
  const hits = await searchMessagesFts(db, {
    q,
    roomIds: readable,
    limit,
    offset,
  });

  const ids = hits.map((h) => h.entity);
  const { messages } = await selectMessages(db, { kind: "ids", ids }, userDid ?? "");

  // selectMessages sorts ascending by sort_idx; search results should stay
  // in FTS rank order (best match first).
  const byId = new Map(messages.map((m) => [m.id, m]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((m): m is MessageDto => m !== undefined);

  const result: SearchMessagesResult = { messages: ordered };
  if (hits.length === limit) {
    result.cursor = String(offset + limit);
  }
  return stripNulls(result as unknown as Record<string, unknown>) as SearchMessagesResult;
};
