/**
 * Derived-state side-effects for `space.roomy.message.deleteMessage.v0`.
 *
 * The SDK materialiser only deletes the entity rows (the message, and any
 * forward references to it). That is enough for room-scoped READS, but a delete
 * must also unwind the derived state `createMessage` built, or the appserver
 * keeps serving the deleted message out of derived paths that name it:
 *
 *   - `activity_item` → the deleted message stays in the room's
 *     `recent_message_ids` window and keeps being rendered by the activity feed
 *     until the window happens to roll. A room whose messages are ALL deleted
 *     keeps listing as an activity item with a stale message list (or none).
 *
 * Unread needs no unwind: it is derived from the reader's position and the
 * room's message set, so removing a message from that set lowers every
 * affected count. The delete path and the move path share
 * `rebuildActivityWindow`, so the two cannot drift apart.
 *
 * `room_activity` is left invalidated, not rebuilt. The delete's own
 * maintenance step already removed the room's row inside the chunk
 * transaction, and the read path re-derives a missing row from the live tables
 * on first access (`readRoomActivityProjectionFor`). A rebuild here would put a
 * scan of every message in the room on the write path, so the sendEvents call
 * that carried one bridged delete would pay for the room's whole history. A
 * missing row is the same state a replayed create leaves behind, and the read
 * path treats both identically.
 */

import type { DbLike } from "../db/types.ts";
import type { DecodedStreamEvent } from "@roomy-space/sdk";
import { rebuildActivityWindow } from "./roomDerivedState.ts";

/**
 * Apply a chunk's deletes.
 *
 * `db` is the per-space DB. Everything this does is per-space derived state,
 * so it runs on backfill too — a replay must leave the activity window
 * matching the room's contents. The board projection needs no rebuild: its
 * row was invalidated by the delete itself, and a read re-derives it.
 */
export async function applyDeleteSideEffects(
  db: DbLike,
  deletes: ReadonlyArray<{ roomId: string }>,
): Promise<void> {
  if (deletes.length === 0) return;

  // Rebuilding once per affected room (not once per delete) keeps a batch of N
  // deletes in one room from recomputing the same window N times.
  const rooms = new Set<string>();
  for (const d of deletes) if (d.roomId) rooms.add(d.roomId);
  for (const roomId of rooms) await rebuildActivityWindow(db, roomId);
}

/**
 * Collect a chunk's deletes, keyed by the room each victim was in.
 *
 * Takes the decoded events the write path holds, so the read happens once for
 * the whole chunk rather than per event.
 */
export function collectPendingDeletes(
  chunk: readonly DecodedStreamEvent[],
): Array<{ roomId: string }> {
  const targets: Array<{ roomId: string }> = [];
  for (const decoded of chunk) {
    const event = decoded.event as {
      $type: string;
      room?: unknown;
    };
    if (event.$type !== "space.roomy.message.deleteMessage.v0") continue;
    const roomId = typeof event.room === "string" ? event.room : "";
    if (!roomId) continue;
    targets.push({ roomId });
  }
  return targets;
}