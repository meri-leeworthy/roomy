/**
 * XRPC: space.roomy.federation.getGrants (query).
 *
 * Returns the per-channel federation grants touching a space, for its admins:
 *   - `originGrants`: channels of this space (A) that A has exposed to other
 *     spaces B (`federation_room_permissions`, keyed on the owning space).
 *   - `receiverGrants`: channels of other spaces (origins) that have been
 *     federated *into* this space B, and the receiver grants B's admins have
 *     set for its members/roles (`federation_receiver_permissions`).
 *
 * Feeds the settings Federations UI: the origin-grant toggles (A side) and
 * the receiver-grant config (B side).
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface OriginGrant {
  federatingSpaceDid: string;
  roomId: string;
  permission: "read" | "readwrite";
}

interface ReceiverGrant {
  originSpaceId: string;
  roomId: string;
  grantee: string;
  kind: "user" | "role";
  permission: "read" | "readwrite";
}

interface GetGrantsResult {
  originGrants: OriginGrant[];
  receiverGrants: ReceiverGrant[];
}

export const getFederationGrantsHandler: QueryHandler<
  QueryParams,
  GetGrantsResult
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
      "Only space admins can view federation grants",
    );
  }

  const db = openGlobalDb();

  const originRows = await db
    .query(
      `select federating_space_did, room_id, permission
         from federation_room_permissions
        where space_id = ?
        order by federating_space_did, room_id`,
    )
    .all<{
      federating_space_did: string;
      room_id: string;
      permission: "read" | "readwrite";
    }>(spaceId);

  const receiverRows = await db
    .query(
      `select space_id, room_id, grantee, kind, permission
         from federation_receiver_permissions
        where federating_space_did = ?
        order by space_id, room_id, kind, grantee`,
    )
    .all<{
      space_id: string;
      room_id: string;
      grantee: string;
      kind: "user" | "role";
      permission: "read" | "readwrite";
    }>(spaceId);

  return {
    originGrants: originRows.map((r) => ({
      federatingSpaceDid: r.federating_space_did,
      roomId: r.room_id,
      permission: r.permission,
    })),
    receiverGrants: receiverRows.map((r) => ({
      originSpaceId: r.space_id,
      roomId: r.room_id,
      grantee: r.grantee,
      kind: r.kind,
      permission: r.permission,
    })),
  };
};
