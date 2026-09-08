/**
 * Schema for `space.roomy.space.getBridgeTokens` (query).
 *
 * Lists the bridge-token grants a space has received, with each grant's
 * grant-time capacity snapshot and spent status. No Polar calls — live
 * validity is only re-resolved by the admin getSpaceMembership endpoint.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getBridgeTokens" as const;

export const Params = type({
  spaceId: "string",
});

export const BridgeToken = type({
  grantorDid: "string",
  spent: "boolean",
  capacitySnapshot: "number",
});

export const Response = type({
  tokens: BridgeToken.array(),
});
