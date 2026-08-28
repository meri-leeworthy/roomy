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
 * grouped display.
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

export const RoomSearchResult = type({
  id: "string",
  name: "string",
  kind: "'channel' | 'thread'",
  canWrite: "boolean",
  /** Canonical parent channel id (threads only). */
  "channelId?": "string",
  /** Canonical parent channel name (threads only). */
  "channelName?": "string",
});

export const Response = type({
  rooms: RoomSearchResult.array(),
});
