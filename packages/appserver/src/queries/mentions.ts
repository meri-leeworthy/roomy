/**
 * Global mentions index: read/write helpers.
 *
 * The `mentions` table lives in the global DB (cross-space — a user's
 * mentions span every space they're in). It's dual-written during
 * materialization so:
 *   - a client subscribed to the `mentions:<did>` sync topic can backfill
 *     history via `space.roomy.mention.getMentions` with one query, and
 *   - deleteMessage can resolve which DIDs a deleted message mentioned.
 *
 * The DID is the stable ID (never the handle or display name).
 */
import type { DbLike } from "../db/types.ts";
import type { AppliedEvent, MessageDiffOp } from "../invalidation/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import { selectMessages, type MessageDto } from "./selectMessages.ts";
import { openSpaceDb } from "../db/db.ts";

export interface MentionRow {
  did: UserDid;
  message_id: Ulid;
  space_did: StreamDid;
  room_id: Ulid;
  created_at: number;
}

/**
 * Sync the global mentions index for a batch of applied events.
 *
 * - createMessage: insert a row per mentioned DID (excluding the author).
 * - editMessage: replace the message's rows (mentions may have changed).
 * - deleteMessage: remove the message's rows.
 *
 * Callers pass the global DB handle; the per-space DB is only needed to
 * re-read a message's content for edit (to re-derive mentions when the
 * event doesn't carry them — not currently the case, since toAppliedEvent
 * populates details.mentions for both create and edit).
 */
export async function syncMentionsIndex(
  globalDb: DbLike,
  events: readonly AppliedEvent[],
): Promise<void> {
  for (const event of events) {
    const roomId = event.roomId;
    if (!roomId) continue;

    switch (event.type) {
      case "space.roomy.message.createMessage.v0":
      case "space.roomy.message.forwardMessages.v0": {
        const mentions = event.details?.mentions as string[] | undefined;
        if (!mentions || mentions.length === 0) break;
        const now = Date.now();
        for (const did of mentions) {
          if (did === event.user) continue; // self-mention
          await globalDb.run(
            `insert or ignore into mentions (did, message_id, space_did, room_id, created_at)
             values (?, ?, ?, ?, ?)`,
            [did, event.id, event.streamDid, roomId, now],
          );
        }
        break;
      }
      case "space.roomy.message.editMessage.v0": {
        const messageId = (event.details?.messageId as Ulid | undefined) ?? event.id;
        await globalDb.run(`delete from mentions where message_id = ?`, [messageId]);
        const mentions = event.details?.mentions as string[] | undefined;
        if (!mentions || mentions.length === 0) break;
        const now = Date.now();
        for (const did of mentions) {
          if (did === event.user) continue;
          await globalDb.run(
            `insert or ignore into mentions (did, message_id, space_did, room_id, created_at)
             values (?, ?, ?, ?, ?)`,
            [did, messageId, event.streamDid, roomId, now],
          );
        }
        break;
      }
      case "space.roomy.message.deleteMessage.v0": {
        const messageId = (event.details?.messageId as Ulid | undefined) ?? event.id;
        await globalDb.run(`delete from mentions where message_id = ?`, [messageId]);
        break;
      }
    }
  }
}

/**
 * Resolve the DIDs a message mentioned (from the global index). Used by
 * deleteMessage to emit `remove` mention ops for the right users.
 */
export async function getMentionedDidsForMessage(
  globalDb: DbLike,
  messageId: Ulid,
): Promise<UserDid[]> {
  const rows = await globalDb
    .query(`select did from mentions where message_id = ?`)
    .all<{ did: string }>([messageId]);
  return rows.map((r) => r.did as UserDid);
}

/**
 * Fetch recent mentions for a DID, newest first, with cursor pagination.
 * Returns the mention rows plus the message snapshots and space/room context.
 */
export async function getMentions(
  globalDb: DbLike,
  did: UserDid,
  limit: number,
  cursor?: string,
): Promise<{ mentions: MentionRow[]; cursor?: string }> {
  const rows = cursor
    ? await globalDb
        .query(
          `select did, message_id, space_did, room_id, created_at
           from mentions
           where did = ? and created_at < ?
           order by created_at desc
           limit ?`,
        )
        .all<MentionRow>([did, Number(cursor), limit + 1])
    : await globalDb
        .query(
          `select did, message_id, space_did, room_id, created_at
           from mentions
           where did = ?
           order by created_at desc
           limit ?`,
        )
        .all<MentionRow>([did, limit + 1]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0
    ? String(page[page.length - 1]!.created_at)
    : undefined;

  return { mentions: page, cursor: nextCursor };
}

/**
 * Load the full message snapshots for a set of mention rows, grouped by
 * space (each space's messages live in that space's per-space DB).
 *
 * The `mentions` table lives in the global DB, but the message rows (and the
 * `entities`/`comp_*` tables they join against) live in per-space DBs — so
 * this routes each space's message batch to that space's DB. Querying the
 * global DB here would fail with "no such table: entities".
 */
export async function loadMentionMessages(
  rows: MentionRow[],
): Promise<Map<Ulid, MessageDto>> {
  const bySpace = new Map<StreamDid, Ulid[]>();
  for (const row of rows) {
    const ids = bySpace.get(row.space_did) ?? [];
    ids.push(row.message_id);
    bySpace.set(row.space_did, ids);
  }
  const out = new Map<Ulid, MessageDto>();
  for (const [spaceDid, ids] of bySpace) {
    const { messages } = await selectMessages(openSpaceDb(spaceDid), {
      kind: "ids",
      ids,
    });
    for (const m of messages) out.set(m.id as Ulid, m);
  }
  return out;
}
