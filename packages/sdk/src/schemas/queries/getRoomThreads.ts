/**
 * Schema for `space.roomy.room.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getThreads.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getThreads" as const;

export const Params = type({ roomId: "string", "limit?": "string", "cursor?": "string" });

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

export const RoomThread = type({
  id: "string",
  "name?": "string",
  "canonicalParent?": "string",
  "unreadCount?": "number",
  /**
   * Honest unread flag for the threads view: true when the thread has
   * messages the user hasn't read, including threads they haven't engaged
   * with (no read_positions row). UI badges only count engaged threads;
   * this field is what the threads view renders.
   */
  "unread?": "boolean",
  activity: ThreadActivity,
});

export const Response = type({
  threads: RoomThread.array(),
  "cursor?": "string",
});
