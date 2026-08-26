/**
 * Per-space full-text message search (SQLite FTS5).
 *
 * Phase 1 of docs/plans/search-endpoints.md (Option A): a dedicated
 * `message_fts` virtual table in the per-space DB, populated by the
 * materialiser alongside `comp_content`. This module runs the FTS query with
 * bm25 ranking + snippet, pre-filtered by the caller's readable room set.
 *
 * The caller is responsible for authorisation — this module does not check
 * read access; it takes the readable room set as input.
 */

import type { DbLike } from "../db/types.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { stripMarkdownToPlaintext } from "../push/plaintext.ts";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";

export interface FtsHit {
  entity: string;
  room: string;
  author_did: string | null;
  timestamp: string | null;
  snippet: string;
  rank: number;
}

export interface SearchMessagesOpts {
  /** Raw user query (already validated ≥ 3 chars by the handler). */
  q: string;
  /** Room IDs the caller can read; results are restricted to these. */
  roomIds: string[];
  limit: number;
  offset: number;
}

/**
 * Build an FTS5 match expression from a raw user query.
 *
 * Each whitespace-separated token is wrapped in double quotes (FTS5 phrase
 * syntax) so user input can't inject FTS5 operators (`AND`, `OR`, `*`, `-`,
 * parentheses, etc.). Tokens are implicitly ANDed. Inner double quotes are
 * escaped by doubling (the FTS5 quoted-string escape).
 */
export function ftsMatchExpression(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Extract the plaintext to index for a message content blob.
 *
 * - Rich text (`application/vnd.roomy.richtext+json`): decode the blocks and
 *   concatenate their text via `blocksToPlaintext`.
 * - Legacy text/* : decode the string and strip markdown/HTML.
 * - Anything else / unparseable: empty string (nothing to index).
 */
export function extractMessageText(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (data === null) return "";
  if (mime === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(mime, data);
    if (blocks) return blocksToPlaintext(blocks);
    return "";
  }
  if (!mime || mime.startsWith("text/") || mime === "application/json") {
    return stripMarkdownToPlaintext(decodeContent(mime, data));
  }
  return "";
}

/**
 * Run an FTS5 search over `message_fts`, restricted to the given rooms.
 *
 * Results are ordered by bm25 rank (best first), then entity id as a stable
 * tiebreak. `limit`/`offset` implement cursor pagination (the handler turns
 * the cursor into an offset).
 */
export async function searchMessagesFts(
  db: DbLike,
  opts: SearchMessagesOpts,
): Promise<FtsHit[]> {
  if (opts.roomIds.length === 0) return [];

  const match = ftsMatchExpression(opts.q);
  if (match === "") return [];

  const placeholders = opts.roomIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select entity, room, author_did, timestamp,
              snippet(message_fts, 3, '[', ']', '…', 12) as snippet,
              bm25(message_fts) as rank
         from message_fts
        where message_fts match ?
          and room in (${placeholders})
        order by rank, entity
        limit ? offset ?`,
    )
    .all<{
      entity: string;
      room: string;
      author_did: string | null;
      timestamp: string | null;
      snippet: string;
      rank: number;
    }>([match, ...opts.roomIds, opts.limit, opts.offset]);

  return rows.map((r) => ({
    entity: r.entity,
    room: r.room,
    author_did: r.author_did,
    timestamp: r.timestamp,
    snippet: r.snippet,
    rank: r.rank,
  }));
}

/**
 * Re-index a single message into `message_fts` from the materialised rows.
 *
 * Reads the message's room, author and content from the per-space DB (the
 * source of truth after the chunk's statements applied) and delete-then-
 * inserts the FTS row. FTS5 has no unique constraint, so an upsert must be
 * delete-then-insert to avoid duplicate rows on edit/re-materialisation.
 *
 * Messages with no indexable text (empty content, or no comp_content row)
 * are dropped from the index.
 */
export async function indexMessageFts(
  db: DbLike,
  entityId: string,
): Promise<void> {
  const row = await db
    .query(
      `select e.room as room,
              cc.mime_type as mime_type,
              cc.data as data,
              cc.timestamp as timestamp,
              author_e.tail as author_did
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
        where e.id = ?`,
    )
    .get<{
      room: string | null;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      timestamp: number | null;
      author_did: string | null;
    }>(entityId);

  // No entity, or no room (not a message) → nothing to index.
  if (row === null || row.room === null) return;

  const text = extractMessageText(row.mime_type, row.data);
  if (text === "") {
    await db.run("delete from message_fts where entity = ?", [entityId]);
    return;
  }

  const timestamp = row.timestamp != null ? new Date(row.timestamp).toISOString() : null;
  await db.transaction([
    {
      type: "run",
      sql: "delete from message_fts where entity = ?",
      params: [entityId],
    },
    {
      type: "run",
      sql: `insert into message_fts (entity, room, author_did, content, timestamp)
            values (?, ?, ?, ?, ?)`,
      params: [entityId, row.room, row.author_did, text, timestamp],
    },
  ]);
}

/**
 * Remove a message from the FTS index (deleteMessage).
 */
export async function removeMessageFts(
  db: DbLike,
  entityId: string,
): Promise<void> {
  await db.run("delete from message_fts where entity = ?", [entityId]);
}
