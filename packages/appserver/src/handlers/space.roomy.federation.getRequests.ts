/**
 * XRPC: space.roomy.federation.getRequests (query).
 *
 * Returns the pending federation requests addressed to a space (A). Visible
 * only to that space's admins, who use it to approve or reject requests.
 */

import { requireFederationAdmin } from "./federationAdmin.ts";
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
  const { spaceId, db } = await requireFederationAdmin(
    params,
    auth,
    "federation requests",
  );
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
