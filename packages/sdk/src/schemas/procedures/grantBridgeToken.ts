/**
 * Schema for `space.roomy.space.grantBridgeToken` (procedure).
 *
 * Grants the caller's Roomy Pro bridge token to a space. One active grant
 * per user (primary key = grantor DID); granting while a pending grant
 * exists (to any space) is rejected with 409. Capacity is resolved live
 * from Polar — a non-Pro caller has capacity 0 and is rejected.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.grantBridgeToken" as const;

export const Input = type({
  spaceId: "string",
});

export const Output = type({
  status: "'pending'",
  /** Capacity the grant carries (from Polar at grant time). */
  capacity: "number",
});
