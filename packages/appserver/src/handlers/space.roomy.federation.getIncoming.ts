/**
 * XRPC: space.roomy.federation.getIncoming (query).
 *
 * Returns the federations *into* a space (B): relationships where B is the
 * receiving/federating space. Visible to B's admins so they can see which
 * origin spaces expose channels to B and their status.
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface FederationRow {
  originSpaceDid: string;
  status: string;
  requestedByDid: string;
  requestedAt: number;
  decidedByDid?: string;
  decidedAt?: number;
}

interface GetIncomingResult {
  federations: FederationRow[];
}

export const getFederationIncomingHandler: QueryHandler<
  QueryParams,
  GetIncomingResult
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
      "Only space admins can view incoming federations",
    );
  }

  const db = openGlobalDb();
  const rows = await db
    .query(
      `select space_id, status, requested_by_did, requested_at,
              decided_by_did, decided_at
         from space_federations
        where federating_space_did = ?
        order by requested_at desc`,
    )
    .all<{
      space_id: string;
      status: string;
      requested_by_did: string;
      requested_at: number;
      decided_by_did: string | null;
      decided_at: number | null;
    }>(spaceId);

  return {
    federations: rows.map((r) => ({
      originSpaceDid: r.space_id,
      status: r.status,
      requestedByDid: r.requested_by_did,
      requestedAt: r.requested_at,
      ...(r.decided_by_did ? { decidedByDid: r.decided_by_did } : {}),
      ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    })),
  };
};
