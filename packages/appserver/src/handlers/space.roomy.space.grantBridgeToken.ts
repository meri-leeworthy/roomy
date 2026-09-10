/**
 * XRPC: space.roomy.space.grantBridgeToken (procedure).
 *
 * Grants the caller's Roomy Pro bridge token to a space. One active grant
 * per grantor — granting while any pending grant exists (to this or another
 * space) is rejected with 409; the caller must explicitly revoke the
 * existing grant first. A spent grant is permanent and cannot be granted
 * again (409).
 *
 * Capacity is resolved live from Polar (TTL-cached per grantor):
 *   - no valid Polar state → "not a Pro member" error
 *   - Polar unavailable AND no cached state → 503 (nothing known)
 *   - otherwise the grant is inserted with the resolved capacity snapshot.
 *
 * The caller must be a member (or admin) of the target space.
 */

import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { resolveGrantorCapacity } from "../billing/capacity.ts";
import {
  deleteGrant,
  insertGrant,
  selectGrantForGrantor,
} from "../queries/bridgeTokens.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface GrantBridgeTokenBody {
  spaceId?: unknown;
}

interface GrantBridgeTokenResult {
  status: "pending";
  capacity: number;
}

export const grantBridgeTokenHandler: ProcedureHandler<
  GrantBridgeTokenBody,
  GrantBridgeTokenResult
> = async (_params: QueryParams, auth: AuthCtx, body: GrantBridgeTokenBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
  if (spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }

  await hydrateUserMembership(userDid);
  const spaceDb = openSpaceDb(spaceId);
  await requireSpaceAccess(spaceDb, spaceId, userDid);

  // Resolve the Polar state for the grantor (fail-open on the TTL cache).
  const { capacity } = await resolveGrantorCapacity(userDid);
  if (capacity <= 0) {
    throw new XrpcError(
      403,
      "NotProMember",
      "not a Pro member",
    );
  }

  const readStateDb = openReadStateDb();
  const existing = await selectGrantForGrantor(readStateDb, userDid);
  if (existing) {
    if (existing.spent_at !== null) {
      throw new XrpcError(
        409,
        "AlreadySpent",
        "This bridge token is already spent and cannot be granted again",
      );
    }
    throw new XrpcError(
      409,
      "AlreadyGranted",
      "Token already granted — revoke it first",
    );
  }

  await insertGrant(readStateDb, {
    grantor_did: userDid,
    space_did: spaceId,
    capacity_snapshot: capacity,
  });

  return { status: "pending", capacity };
};
