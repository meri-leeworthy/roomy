/**
 * Schema for `space.roomy.federation.getOutgoing` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.federation.getOutgoing.ts
 *
 * Returns the federations from a space (A): relationships where A is the
 * origin, visible to A's admins.
 */
import { type } from "arktype";

export const NSID = "space.roomy.federation.getOutgoing" as const;

export const Params = type({ spaceId: "string" });

export const Federation = type({
  federatingSpaceDid: "string",
  status: "'pending' | 'active' | 'rejected' | 'removed'",
  requestedByDid: "string",
  requestedAt: "number",
  "decidedByDid?": "string",
  "decidedAt?": "number",
  "message?": "string",
});

export const Response = type({
  federations: Federation.array(),
});
