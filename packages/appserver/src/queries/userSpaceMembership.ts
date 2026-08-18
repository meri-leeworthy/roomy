/**
 * Durable user-space membership intent, stored in the read-state DB.
 *
 * This is the appserver's source of truth for *which spaces a user intends to
 * participate in* during the transition to ATProto permission records. It is
 * written transactionally alongside join/leave events and read by getSpaces,
 * hydration and the activity feed.
 *
 * Actual space access (member/admin/ban) remains derived from the space's own
 * per-space DB — this table only records intent, so a `joined` row does not by
 * itself grant access.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, UserDid } from "@roomy-space/sdk";

export type MembershipState = "joined" | "left";

export interface UserSpaceMembershipRow {
  user_did: string;
  space_did: string;
  state: MembershipState;
  source: string;
  source_event_id: string;
  updated_at: number;
}

/**
 * Record a user's membership intent for a space. One row per (user, space);
 * the latest write wins. Idempotent — re-joining or re-leaving just updates
 * the row.
 */
export async function setUserSpaceMembership(
  db: DbLike,
  userDid: UserDid,
  spaceDid: StreamDid,
  state: MembershipState,
  source: string,
  sourceEventId: string,
): Promise<void> {
  await db.run(
    `insert into user_space_membership
       (user_did, space_did, state, source, source_event_id, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(user_did, space_did) do update set
       state = excluded.state,
       source = excluded.source,
       source_event_id = excluded.source_event_id,
       updated_at = excluded.updated_at`,
    [userDid, spaceDid, state, source, sourceEventId, Date.now()],
  );
}

/**
 * Return the space DIDs the user has joined and not left (active intent).
 */
export async function selectJoinedSpaceDids(
  db: DbLike,
  userDid: UserDid,
): Promise<StreamDid[]> {
  const rows = await db
    .query(
      `select space_did as id
         from user_space_membership
        where user_did = ? and state = 'joined'
        order by updated_at desc`,
    )
    .all<{ id: string }>([userDid]);
  return rows.map((r) => r.id as StreamDid);
}

export interface UserSpaceRow {
  space_did: string;
  state: MembershipState;
}

/**
 * Return all membership rows for a user, optionally including left spaces.
 * When `includeLeft` is false, only `joined` rows are returned.
 */
export async function selectUserSpaces(
  db: DbLike,
  userDid: UserDid,
  includeLeft = false,
): Promise<UserSpaceRow[]> {
  const rows = await db
    .query(
      `select space_did, state
         from user_space_membership
        where user_did = ? ${includeLeft ? "" : "and state = 'joined'"}
        order by updated_at desc`,
    )
    .all<{ space_did: string; state: MembershipState }>([userDid]);
  return rows.map((r) => ({ space_did: r.space_did, state: r.state }));
}
