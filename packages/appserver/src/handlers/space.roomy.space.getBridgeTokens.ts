/**
 * XRPC: space.roomy.space.getBridgeTokens (query).
 *
 * Lists the bridge-token grants a space has received: grantor DID,
 * grant-time capacity snapshot, and spent status. Space members (existing
 * access checks) may read it. Makes NO Polar calls — live validity is only
 * re-resolved by the admin `space.roomy.admin.getSpaceMembership` endpoint.
 */

import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectGrantsForSpace } from "../queries/bridgeTokens.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface GetBridgeTokensResult {
  tokens: {
    grantorDid: string;
    spent: boolean;
    capacitySnapshot: number;
  }[];
}

export const getBridgeTokensHandler: QueryHandler<
  QueryParams,
  GetBridgeTokensResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);
  const spaceDb = openSpaceDb(spaceId);
  await requireSpaceAccess(spaceDb, spaceId, userDid);

  const readStateDb = openReadStateDb();
  const rows = await selectGrantsForSpace(readStateDb, spaceId);

  return {
    tokens: rows.map((r) => ({
      grantorDid: r.grantor_did,
      spent: r.spent_at !== null,
      capacitySnapshot: r.capacity_snapshot,
    })),
  };
};
