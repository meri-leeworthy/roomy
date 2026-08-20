/**
 * Schema for `space.roomy.federation.getGrants` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.federation.getGrants.ts
 *
 * Returns the per-channel federation grants touching a space, for its admins:
 * origin grants (this space A exposes channels to B) and receiver grants
 * (channels of origin spaces federated into this space B).
 */
import { type } from "arktype";

export const NSID = "space.roomy.federation.getGrants" as const;

export const Params = type({ spaceId: "string" });

export const OriginGrant = type({
  federatingSpaceDid: "string",
  roomId: "string",
  permission: "'read' | 'readwrite'",
});

export const ReceiverGrant = type({
  originSpaceId: "string",
  roomId: "string",
  grantee: "string",
  kind: "'user' | 'role'",
  permission: "'read' | 'readwrite'",
});

export const Response = type({
  originGrants: OriginGrant.array(),
  receiverGrants: ReceiverGrant.array(),
});
