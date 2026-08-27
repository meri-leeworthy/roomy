/**
 * Schema for `space.roomy.search.messages` (query).
 *
 * Full-text message search backed by Qdrant, filtered by the caller's read
 * access. With `spaceId` the search is scoped to one space; without it the
 * search spans every space the caller has joined (cross-space). Returns
 * messages hydrated via selectMessages so the response shape matches the
 * shared Message schema, plus `roomId`/`spaceId` so cross-space results can
 * be linked back to their source room.
 */
import { scope, type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.search.messages" as const;

export const Params = type({
  /** Narrow the search to one space. Omitted → search the caller's joined spaces. */
  "spaceId?": "string",
  /** Search query. Must be at least 3 characters. */
  q: "string",
  "limit?": "string",
  "cursor?": "string",
});

/**
 * A search hit: the shared Message shape plus the room/space it lives in.
 * The appserver hydrates via selectMessages and annotates each result with
 * its source room and space so the client can deep-link into the room.
 */
export const SearchMessage = Message.and({
  roomId: "string",
  spaceId: "string",
});

export const Response = type({
  messages: SearchMessage.array(),
  "cursor?": "string",
});
