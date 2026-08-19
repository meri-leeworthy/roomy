/**
 * Schema for `space.roomy.federation.getIncoming` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.federation.getIncoming.ts
 *
 * Returns the federations into a space (B): relationships where B is the
 * receiving/federating space, visible to B's admins.
 */
import { type } from "arktype";

export const NSID = "space.roomy.federation.getIncoming" as const;

export const Params = type({ spaceId: "string" });

export const Federation = type({
  originSpaceDid: "string",
  status: "'pending' | 'active' | 'rejected' | 'removed'",
  requestedByDid: "string",
  requestedAt: "number",
  "decidedByDid?": "string",
  "decidedAt?": "number",
});

export const Response = type({
  federations: Federation.array(),
});
