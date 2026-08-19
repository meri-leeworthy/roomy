/**
 * XRPC: space.roomy.federation.getRequests (query).
 *
 * Returns the pending federation requests addressed to a space (A). Visible
 * only to that space's admins, who use it to approve or reject requests.
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RequestRow {
  federatingSpaceDid: string;
  requestedByDid: string;
  requestedAt: number;
  message?: string;
}

interface GetRequestsResult {
  requests: RequestRow[];
}

export const getFederationRequestsHandler: QueryHandler<
  QueryParams,
  GetRequestsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const spaceDb = openSpaceDb(spaceId);
  const access = await requireSpaceAccess(spaceDb, spaceId, userDid);
  if (!access.isAdmin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Only space admins can view federation requests",
    );
  }

  const db = openGlobalDb();
  const rows = await db
    .query(
      `select federating_space_did, requested_by_did, requested_at, message
         from space_federations
        where space_id = ? and status = 'pending'
        order by requested_at asc`,
    )
    .all<{
      federating_space_did: string;
      requested_by_did: string;
      requested_at: number;
      message: string | null;
    }>(spaceId);

  return {
    requests: rows.map((r) => ({
      federatingSpaceDid: r.federating_space_did,
      requestedByDid: r.requested_by_did,
      requestedAt: r.requested_at,
      ...(r.message ? { message: r.message } : {}),
    })),
  };
};
