/**
 * Channel-federation access resolution.
 *
 * Federation lets a channel owned by space A be read and written by members
 * of space B. It is a "virtual grant" layered on top of the normal per-space
 * `roomAccess`:
 *
 *   effective(A_channel, did, homeSpace=B) =
 *     origin grant    (A-admin sets read/readwrite for B on the channel)
 *     × receiver grant (B-admin sets per-member/role; Phase 3)
 *
 * Rules:
 *   - An **admin of the receiving space B** gets origin-level access (they
 *     manage the federation), so federated channels are visible to B admins
 *     before any receiver grant is set.
 *   - A **non-admin B member** needs a receiver grant (kind='user' for their
 *     DID, or kind='role' for a role they hold in B). Effective access is the
 *     more restrictive of the origin grant and the receiver grant — a
 *     receiver grant can never exceed the origin ceiling.
 *   - No receiver grant ⇒ no access for non-admin B members.
 *
 * This module is decision-only (same coupling rules as `access.ts`): it takes
 * DB handles, performs no I/O beyond queries on them, and has no XRPC/HTTP
 * awareness. It is consulted only when the native `roomAccess` denies, so
 * non-federated spaces pay no cost.
 *
 * Threads inherit from their parent channel (see plan §5.5): grants are keyed
 * on the canonical parent channel, mirroring `access.ts`'s
 * `permRoom = parentChannelId ?? roomId`.
 */

import type { DbLike } from "../db/types.ts";
import { resolveRoom, spaceAccess } from "./access.ts";

export interface FederatedRoomAccess {
  canRead: boolean;
  canWrite: boolean;
  /** The caller's home space (B) through which the federation is granted. */
  homeSpaceDid: string | null;
}

export interface FederationAccessOptions {
  /**
   * Resolve a space's per-space DB by DID. Needed to check B role membership
   * (receiver role grants) and B admin status. When omitted, only direct
   * user receiver grants and the origin grant are considered.
   */
  spaceDbResolver?: (spaceDid: string) => DbLike;
}

type Permission = "read" | "readwrite";

function level(p: Permission): number {
  return p === "readwrite" ? 2 : 1;
}
/** More restrictive of two permissions (read < readwrite). */
function minPermission(a: Permission, b: Permission): Permission {
  return level(a) <= level(b) ? a : b;
}
/** Most permissive of two permissions (for combining multiple grants). */
function maxPermission(a: Permission | null, b: Permission): Permission {
  if (a === null) return b;
  return level(a) >= level(b) ? a : b;
}

/**
 * Resolve a caller's federated access to a room owned by another space.
 *
 * Returns `null` when the caller has no federated access (e.g. the room isn't
 * federated to any space the caller belongs to, the relationship isn't
 * active, the caller isn't a member of the receiving space, or — for a
 * non-admin B member — there is no receiver grant).
 *
 * `did` must be non-null; anonymous callers are never federated.
 */
export async function federatedRoomAccess(
  spaceDb: DbLike, // owning (origin) space A DB
  globalDb: DbLike, // global registry DB
  roomId: string,
  did: string,
  opts: FederationAccessOptions = {},
): Promise<FederatedRoomAccess | null> {
  const { row, parentChannelId } = await resolveRoom(spaceDb, roomId);
  if (row === null || row.spaceId === null) return null;
  const originSpace = row.spaceId;
  const grantRoom = parentChannelId ?? roomId;

  // The caller's membership spaces (head = user DID, tail = space DID).
  const spaces = await globalDb
    .query("select tail from edges where head = ? and label = 'joinedSpace'")
    .all<{ tail: string }>(did);

  for (const s of spaces) {
    const homeSpace = s.tail;

    // Active federation from origin -> this home space?
    const fed = await globalDb
      .query(
        "select 1 as n from space_federations where space_id = ? and federating_space_did = ? and status = 'active'",
      )
      .get<{ n: number }>(originSpace, homeSpace);
    if (!fed) continue;

    // Origin grant on the (parent) channel?
    const origin = await globalDb
      .query(
        "select permission from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?",
      )
      .get<{ permission: Permission }>(originSpace, homeSpace, grantRoom);
    if (!origin) continue;

    // Resolve the caller's standing in the receiving space B once. Used for
    // the B-admin override below, and to deny access to B-banned members
    // (a banned B member must not keep reading/writing a federated channel
    // through a stale receiver grant).
    let bAccess: Awaited<ReturnType<typeof spaceAccess>> | null = null;
    if (opts.spaceDbResolver) {
      const bDb = opts.spaceDbResolver(homeSpace);
      bAccess = await spaceAccess(bDb, homeSpace, did);
    }

    // B admin override: admins of the receiving space get origin-level access.
    if (bAccess?.isAdmin) {
      return {
        canRead: true,
        canWrite: origin.permission === "readwrite",
        homeSpaceDid: homeSpace,
      };
    }

    // A non-admin B member who is banned in B gets no federated access.
    if (bAccess?.isBanned) continue;

    // Receiver grant for a non-admin B member.
    const receiver = await resolveReceiverGrant(
      globalDb,
      opts.spaceDbResolver,
      originSpace,
      homeSpace,
      grantRoom,
      did,
    );
    if (receiver === null) continue; // no receiver grant -> no access

    const effective = minPermission(origin.permission, receiver);
    return {
      canRead: true,
      canWrite: effective === "readwrite",
      homeSpaceDid: homeSpace,
    };
  }

  return null;
}

/**
 * Resolve the most permissive receiver grant a B member holds on a channel:
 * a direct user grant for their DID, plus any role grants for roles they hold
 * in B. Returns null when there is no matching grant.
 */
async function resolveReceiverGrant(
  globalDb: DbLike,
  spaceDbResolver: ((spaceDid: string) => DbLike) | undefined,
  originSpace: string,
  homeSpace: string,
  roomId: string,
  did: string,
): Promise<Permission | null> {
  let best: Permission | null = null;

  const userGrant = await globalDb
    .query(
      "select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = 'user'",
    )
    .get<{ permission: Permission }>(originSpace, homeSpace, roomId, did);
  if (userGrant) best = userGrant.permission;

  if (spaceDbResolver) {
    const bDb = spaceDbResolver(homeSpace);
    const roleIds = await bDb
      .query("select role_id from member_roles where user_id = ? and stream_id = ?")
      .all<{ role_id: string }>(did, homeSpace);
    for (const r of roleIds) {
      const g = await globalDb
        .query(
          "select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = 'role'",
        )
        .get<{ permission: Permission }>(originSpace, homeSpace, roomId, r.role_id);
      if (g) best = maxPermission(best, g.permission);
    }
  }

  return best;
}
