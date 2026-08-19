/**
 * Channel-federation access resolution.
 *
 * Federation lets a channel owned by space A be read (Phase 2) — and later
 * written (Phase 3) — by members of space B. It is a "virtual grant" layered
 * on top of the normal per-space `roomAccess`:
 *
 *   effective(A_channel, did, homeSpace=B) =
 *     origin grant   (A-admin sets read/readwrite for B on the channel)
 *     × receiver grant (B-admin sets per-member/role; Phase 3)
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
import { resolveRoom } from "./access.ts";

export interface FederatedRoomAccess {
  canRead: boolean;
  canWrite: boolean;
  /** The caller's home space (B) through which the federation is granted. */
  homeSpaceDid: string | null;
}

/**
 * Resolve a caller's federated access to a room owned by another space.
 *
 * Returns `null` when the caller has no federated access (e.g. the room isn't
 * federated to any space the caller belongs to, or the relationship isn't
 * active, or the caller isn't a member of the receiving space). Otherwise
 * returns the effective access composed from the origin grant. Receiver
 * grants (Phase 3) will cap this further.
 *
 * `did` must be non-null; anonymous callers are never federated.
 */
export async function federatedRoomAccess(
  spaceDb: DbLike, // owning (origin) space A DB
  globalDb: DbLike, // global registry DB
  roomId: string,
  did: string,
): Promise<FederatedRoomAccess | null> {
  const { row, parentChannelId } = await resolveRoom(spaceDb, roomId);
  if (row === null || row.spaceId === null) return null;
  const originSpace = row.spaceId;
  const grantRoom = parentChannelId ?? roomId;

  // The caller's membership spaces (head = user DID, tail = space DID).
  const spaces = await globalDb
    .query(
      "select tail from edges where head = ? and label = 'joinedSpace'",
    )
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
    const grant = await globalDb
      .query(
        "select permission from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?",
      )
      .get<{ permission: string }>(originSpace, homeSpace, grantRoom);
    if (!grant) continue;

    return {
      canRead: true,
      canWrite: grant.permission === "readwrite",
      homeSpaceDid: homeSpace,
    };
  }

  return null;
}
