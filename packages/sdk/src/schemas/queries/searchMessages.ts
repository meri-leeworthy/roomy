/**
 * Schema for `space.roomy.search.messages` (query).
 *
 * Per-space full-text message search (SQLite FTS5), filtered by the caller's
 * read access. Returns messages hydrated via selectMessages so the response
 * shape matches the shared Message schema.
 */
import { type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.search.messages" as const;

export const Params = type({
  spaceId: "string",
  /** Search query. Must be at least 3 characters. */
  q: "string",
  "limit?": "string",
  "cursor?": "string",
});

export { Message };

export const Response = type({
  messages: Message.array(),
  "cursor?": "string",
});
