/**
 * XRPC: space.roomy.room.getLinks (query).
 *
 * Paginated, newest-first, URL-deduped index of every link shared in a single
 * room, filtered by the caller's read access (the room itself must be
 * readable — a links view is a cross-room read, so the caller's read access
 * is enforced here exactly as for `room.getThreads`).
 *
 * Each link returns its room id (the real room, not the message id — the
 * two-hop join the embed sweeper's invalidation uses is the same here), the
 * message that shared it, and its enriched card (null-safe — absent when the
 * embed service had no data). Each link also carries `timestamp` — when it was
 * shared, derived from the ordering key (absent when not derivable).
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openSpaceDbForEntity, tryOpenGlobalDb } from "../db/db.ts";
import { cursorForRow, dedupeLinks, hydrateLinkEmbeds, linkTimestamp, listLinks } from "../queries/links.ts";
import { hiddenBy } from "../queries/userBlocks.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { withSpan } from "../telemetry/tracing.ts";

interface LinkRow {
  url: string;
  roomId: string;
  messageId: string;
  /** When the link was shared (ISO 8601 UTC), absent when not derivable. */
  timestamp?: string;
  /** Enriched card data (EmbedV1 JSON), absent when the enricher had no data. */
  embed?: Record<string, unknown>;
}

interface GetRoomLinksResult {
  links: LinkRow[];
  cursor?: string;
}

export const getRoomLinksHandler: QueryHandler<
  QueryParams,
  GetRoomLinksResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;

  return withSpan(
    "space.roomy.room.getLinks",
    { "roomy.room_id": roomId, "roomy.limit": limit },
    async (span) => {
      const db = await withSpan("getLinks.openDb", {}, async () =>
        openSpaceDbForEntity(roomId),
      );
      if (!db) {
        throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
      }
      const memo = createAccessMemo();
      await withSpan("getLinks.requireRead", {}, () =>
        requireRoomRead(db, roomId, userDid, memo),
      );

      const { links: raw, hasMore } = await withSpan(
        "getLinks.list",
        {},
        () => listLinks(db, { kind: "room", roomId }, limit, cursor),
      );

      // A link row names the message that shared it; a blocked author's shared
      // URLs must not surface. Drop the hidden authors' rows BEFORE dedup, so
      // a URL shared by both a hidden and a visible author survives through
      // the visible occurrence rather than being collapsed away.
      const hidden = userDid ? await hiddenBy(userDid) : undefined;
      const visible = hidden
        ? raw.filter((r) => !hidden.has(r.author_did ?? ""))
        : raw;
      const deduped = dedupeLinks(visible);
      const globalDb = tryOpenGlobalDb();
      if (globalDb) await hydrateLinkEmbeds(globalDb, deduped);

      // Pagination is derived from the deduped page BEFORE the author filter
      // (the same last row the unfiltered code used): a page whose only row
      // was filtered out would otherwise return no cursor and strand the
      // reader on that page. `deduped` is already the unfiltered dedup when
      // nothing was hidden.
      const cursorPage = hidden ? dedupeLinks(raw) : deduped;
      let nextCursor: string | null = null;
      if (hasMore && cursorPage.length > 0) {
        nextCursor = cursorForRow(cursorPage[cursorPage.length - 1]!);
      }

      const links: LinkRow[] = deduped.map((r) => {
        const link: LinkRow = {
          url: r.url,
          roomId: r.room_id,
          messageId: r.message_id,
        };
        const timestamp = linkTimestamp(r.sort_key);
        if (timestamp !== undefined) link.timestamp = timestamp;
        if (r.embed_json !== null) {
          link.embed = JSON.parse(r.embed_json) as Record<string, unknown>;
        }
        return link;
      });

      span.setAttribute("roomy.link_count", links.length);
      span.setAttribute("roomy.has_cursor", nextCursor != null);
      const result: GetRoomLinksResult = { links };
      if (nextCursor) result.cursor = nextCursor;
      return stripNulls(result as unknown as Record<string, unknown>) as unknown as GetRoomLinksResult;
    },
  );
};
