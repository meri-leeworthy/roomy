/**
 * Schema for `space.roomy.space.getDiscoverableSpaces` (query).
 *
 * Spaces a reader may be pointed at: public to join and not opted out of being
 * suggested (`comp_space.suggest_to_others` unset or 1). The server applies
 * both filters; the client renders what it is given and excludes spaces the
 * reader has already joined.
 *
 * Display fields are not part of the response — a card fetches them through
 * `space.roomy.space.getMetadata`.
 *
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getDiscoverableSpaces.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getDiscoverableSpaces" as const;

/** Params. `limit` caps the page (1-50, default 20). */
export const Params = type({
  "limit?": "string",
});

export const DiscoverableSpace = type({
  id: "string",
});

export const Response = type({
  spaces: DiscoverableSpace.array(),
});
