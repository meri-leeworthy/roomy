/**
 * XRPC: space.roomy.search.messages (query).
 *
 * Cross-space full-text message search backed by Qdrant (Phase 2 of
 * search-endpoints.md). The query is BM25-encoded to a sparse vector and
 * searched against the global `messages` collection, payload-filtered to
 * the caller's readable spaces (spaceId narrows the filter to one space).
 * Results are over-fetched (limit×3), hydrated via selectMessages
 * (`{ kind: "ids" }`), post-filtered by per-room read access, trimmed to
 * `limit`, and returned ranked best-match-first.
 *
 * Supports cursor-based pagination via `limit` and `cursor` (an opaque
 * offset token). The SDK schema is unchanged — one code path serves both
 * per-space and cross-space.
 *
 * When Qdrant is not configured the endpoint returns 503 — search is
 * unavailable without the search service.
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectJoinedSpaceDids } from "../queries/userSpaceMembership.ts";
import { selectMessages } from "../queries/selectMessages.ts";
import { encodeSparse } from "../search/bm25.ts";
import { getQdrantClient, searchMessages } from "../search/qdrantSearch.ts";
import { getQdrant } from "../qdrant.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { MessageDto } from "../queries/selectMessages.ts";
import { log } from "../log.ts";

/** Over-fetch factor: Qdrant returns limit×this candidates, we post-filter. */
const OVERFETCH = 3;

interface SearchMessagesResult {
  messages: Array<MessageDto & { roomId?: string; spaceId?: string }>;
  cursor?: string;
}

export const searchMessagesHandler: QueryHandler<
  QueryParams,
  SearchMessagesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = optionalString(params, "spaceId") ?? null;
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

  const client = getQdrantClient();
  if (!client) {
    throw new XrpcError(
      503,
      "Unavailable",
      "Message search is not configured on this server",
    );
  }

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }
  // Resolve the caller's readable space set. With spaceId the filter narrows
  // to that space (requireSpaceRead below enforces access); without it we
  // filter to the spaces the caller has joined.
  let spaceDids: string[];
  if (spaceId !== null) {
    spaceDids = [spaceId];
    await requireSpaceRead(openSpaceDb(spaceId), spaceId, userDid);
  } else if (userDid === null) {
    // Anonymous callers have no joined spaces to search.
    spaceDids = [];
  } else {
    spaceDids = await selectJoinedSpaceDids(openReadStateDb(), userDid);
  }
  if (spaceDids.length === 0) {
    return { messages: [] };
  }

  const window = limit * OVERFETCH;
  const offset = cursor !== null ? Number(cursor) : 0;
  const sparse = encodeSparse(q);
  let hits;
  try {
    hits = await searchMessages(client, {
      sparse,
      spaceDids,
      // Fixed window: Qdrant's sparse search returns tied points in an
      // order that DEPENDS on the requested limit (limit=1 → [m2],
      // limit=3 → [m1,m3,m2] for identical vectors), so re-fetching with a
      // different limit per page shifts the ordering and slices misalign.
      // A constant limit gives a stable ordering; the appserver slices the
      // window by cursor. The window is the searchable cap — pages beyond
      // it return fewer results and the cursor stops once it is exhausted.
      limit: window,
    });
  } catch (err) {
    // Surface the configured endpoint so a misconfigured QDRANT_URL is
    // diagnosable from the response (Bun's "Unable to connect" is generic —
    // it covers refused, TLS mismatch, and DNS failures alike).
    const config = getQdrant();
    const target = config ? `${config.url}${config.port !== undefined ? `:${config.port}` : ""}` : "unset";
    throw new XrpcError(
      500,
      "InternalServerError",
      `Qdrant search failed (target ${target}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Slice the window by cursor. A single Qdrant response never repeats a
  // point, so each page is distinct; the cursor continues while more
  // results remain in the fetched window and stops once it is exhausted.
  const windowHits = hits.slice(offset, offset + limit);

  // Hydrate per-space, keeping the hits' rank order. Qdrant returns ids;
  // SQLite provides the full message DTOs.
  const ranked: Array<{ message: MessageDto; roomId: string; spaceDid: string }> = [];
  const bySpace = new Map<string, string[]>();
  for (const h of windowHits) {
    const arr = bySpace.get(h.payload.spaceDid) ?? [];
    arr.push(h.messageId);
    bySpace.set(h.payload.spaceDid, arr);
  }
  const hydratedBySpace = new Map<string, Map<string, MessageDto>>();
  for (const [space, ids] of bySpace) {
    const db = openSpaceDb(space);
    try {
      const { messages } = await selectMessages(db, { kind: "ids", ids }, userDid ?? "");
      hydratedBySpace.set(space, new Map(messages.map((m) => [m.id, m])));
    } catch (err) {
      log.warn(`[search] selectMessages failed for space ${space}:`, err);
    }
  }
  for (const h of windowHits) {
    const m = hydratedBySpace.get(h.payload.spaceDid)?.get(h.messageId);
    if (m) ranked.push({ message: m, roomId: h.payload.roomId, spaceDid: h.payload.spaceDid });
  }

  // Post-filter by per-room read access (membership alone is not enough —
  // rooms may restrict access), then trim to the requested limit. Each
  // result carries the room/space it was found in so cross-space search
  // clients can show context and link to the hit.
  const results: Array<MessageDto & { roomId?: string; spaceId?: string }> = [];
  const memos = new Map<string, ReturnType<typeof createAccessMemo>>();
  for (const { message, roomId, spaceDid } of ranked) {
    if (results.length >= limit) break;
    let memo = memos.get(spaceDid);
    if (!memo) {
      memo = createAccessMemo();
      memos.set(spaceDid, memo);
    }
    const acc = await roomAccess(openSpaceDb(spaceDid), roomId, userDid, memo);
    if (acc.canRead) results.push({ ...message, roomId, spaceId: spaceDid });
  }

  const result: SearchMessagesResult = { messages: results };
  // Cursor semantics: offset + limit. Emit while more results remain in the
  // fetched window (this page didn't reach the end of it), or the window
  // itself was full (more may exist beyond it).
  if (offset + limit < hits.length || hits.length === window) {
    result.cursor = String(offset + limit);
  }
  return stripNulls(result as unknown as Record<string, unknown>) as SearchMessagesResult;
};
