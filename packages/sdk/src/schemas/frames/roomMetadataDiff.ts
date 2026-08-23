/**
 * Schema for the `#roomMetadataDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`, one frame per
 * affected user (not a broadcast — each user's connection gets its own frame).
 *
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeRoomMetadataDiff)
 * and packages/appserver/src/invalidation/types.ts (RoomMetadataDiff signal).
 *
 * Header is `{ op: 1, t: "#roomMetadataDiff" }` — encoded separately as the first
 * CBOR value of the frame.
 *
 * The client patches cache entries from this frame, avoiding refetches:
 *   - `space.roomy.room.getMetadata` → `unreadCount += delta`
 *   - `space.roomy.space.getSpaces`   → the matching space's `unreadCount += delta`
 *   - `space.roomy.space.getMetadata` → the channel entry in the sidebar tree
 *
 * `delta` is the unread-count increment (`+1` per message). The client adds it
 * to the cached `unreadCount` rather than replacing the absolute value, so the
 * server never needs to read the current count.
 *
 * `roomUnreadDelta` / `threadUnreadDelta` are per-user increments for the
 * room-count badges: `+1` when this message makes a room newly-unread for the
 * user, `-1` when it makes a room fully-read (e.g. the author reading their
 * own message). `parentChannelId` is the thread's parent channel, so the
 * client can patch the channel-scoped thread count.
 *
 * `seq` is a per-connection monotonic counter the client uses to detect gaps
 * (missed frames) and force a refetch — mirrors `#messageDiff.seq`.
 */
import { type } from "arktype";

export const T = "#roomMetadataDiff" as const;

export const Body = type({
  spaceId: "string",
  roomId: "string",
  delta: "number",
  seq: "number",
  "parentChannelId?": "string",
  "roomUnreadDelta?": "number",
  "threadUnreadDelta?": "number",
});