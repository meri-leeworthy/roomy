/**
 * Schema for `space.roomy.space.revokeBridgeToken` (procedure).
 *
 * Revokes the caller's bridge-token grant for a space. Grantor only — any
 * other caller gets 403. A spent grant (bridged guild exceeded 100 members)
 * is PERMANENT and cannot be revoked (409).
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.revokeBridgeToken" as const;

export const Input = type({
  spaceId: "string",
});

export const Output = type({
  revoked: "boolean",
});
