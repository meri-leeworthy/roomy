/**
 * XRPC: space.roomy.federation.getOutgoing (query).
 *
 * Returns the federations *from* a space (A): relationships where A is the
 * origin. Visible to A's admins so they can manage the spaces federated to
 * A (approve/reject/remove) and, in later phases, configure per-channel
 * grants.
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface FederationRow {
  federatingSpaceDid: string;
  status: string;
  requestedByDid: string;
  requestedAt: number;
  decidedByDid?: string;
  decidedAt?: number;
  message?: string;
}

interface GetOutgoingResult {
  federations: FederationRow[];
}

export const getFederationOutgoingHandler: QueryHandler<
  QueryParams,
  GetOutgoingResult
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
      "Only space admins can view outgoing federations",
    );
  }

  const db = openGlobalDb();
  const rows = await db
    .query(
      `select federating_space_did, status, requested_by_did, requested_at,
              decided_by_did, decided_at, message
         from space_federations
        where space_id = ?
        order by requested_at desc`,
    )
    .all<{
      federating_space_did: string;
      status: string;
      requested_by_did: string;
      requested_at: number;
      decided_by_did: string | null;
      decided_at: number | null;
      message: string | null;
    }>(spaceId);

  return {
    federations: rows.map((r) => ({
      federatingSpaceDid: r.federating_space_did,
      status: r.status,
      requestedByDid: r.requested_by_did,
      requestedAt: r.requested_at,
      ...(r.decided_by_did ? { decidedByDid: r.decided_by_did } : {}),
      ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
      ...(r.message ? { message: r.message } : {}),
    })),
  };
};
