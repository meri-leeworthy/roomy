/**
 * Schema for `space.roomy.search.rooms` (query).
 *
 * Search channels and threads in a space by name (case-insensitive
 * substring), filtered by the caller's read access. Backs the forward
 * modal's room picker — unlike `space.getMetadata`'s `activeThreads`
 * (at most 8 recently-active threads per user), this searches every
 * non-deleted channel and thread in the space.
 *
 * Each result carries `kind` so clients can render channels and threads
 * distinctly, plus `canWrite` so a picker can filter to forwardable
 * targets. Threads include their canonical parent channel id/name for
 * grouped display. Results also carry the same `activity`/`unread` shape
 * as `space.getThreads` so the search page can render board-style rows.
 */
import { type } from "arktype";

export const NSID = "space.roomy.search.rooms" as const;

export const Params = type({
  /** The space to search within. */
  spaceId: "string",
  /** Name substring to match (case-insensitive). Must be non-empty. */
  q: "string",
  "limit?": "string",
});

export const ThreadMember = type({
  did: "string",
  "name?": "string | null",
  "avatar?": "string | null",
});

export const ThreadMessage = type({
  id: "string",
  content: "string",
  author: ThreadMember,
  "timestamp?": "string",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string",
  latestMembers: ThreadMember.array(),
  "latestMessage?": ThreadMessage,
});

export const RoomSearchResult = type({
  id: "string",
  name: "string",
  kind: "'channel' | 'thread'",
  canWrite: "boolean",
  /** Canonical parent channel id (threads only). */
  "channelId?": "string",
  /** Canonical parent channel name (threads only). */
  "channelName?": "string",
  "unreadCount?": "number",
  /**
   * Honest unread flag for the board: true when the room has messages the
   * user hasn't read. For threads this includes never-engaged threads (no
   * read_positions row yet); for channels it's `unreadCount > 0`, matching
   * the sidebar's per-channel unread counts.
   */
  "unread?": "boolean",
  activity: ThreadActivity,
});

export const Response = type({
  rooms: RoomSearchResult.array(),
});
