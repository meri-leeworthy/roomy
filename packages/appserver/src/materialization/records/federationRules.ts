/**
 * Projection rules for the federation kinds: `federationRequest`,
 * `federationGrant` and `federationReceiverGrant`.
 *
 * All three live in the global DB — the relationship registry and the origin and
 * receiver grants — because they are cross-space facts: the request and the
 * origin grants arrive on the origin space's stream, while a receiver grant
 * arrives on the receiving space's stream and names the origin space it caps.
 * Every statement here is marked `global` rather than left to SQL-text routing.
 *
 * A relationship is never removed from the set: `federation.remove` marks it
 * `removed`, which is why the record's delete is a status update. The decision
 * instant is the derivation's own clock and is not a value the log determines.
 */

import { sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { global, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type FederationRequestChange = ChangeOf<"federationRequest">;
export type FederationGrantChange = ChangeOf<"federationGrant">;
export type FederationReceiverGrantChange =
  ChangeOf<"federationReceiverGrant">;

/** The statements that apply one `federationRequest` change. */
export function federationRequestStatements(
  change: FederationRequestChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create": {
      const record = change.record;
      return [
        global(sql`
          insert into space_federations (
            space_id, federating_space_did, status,
            requested_by_did, requested_at, message
          )
          values (
            ${ctx.streamId},
            ${record.federatingSpace},
            'pending',
            ${record.requestedBy},
            ${ctx.decidedAt},
            ${record.message}
          )
          on conflict(space_id, federating_space_did) do update set
            status = case
              when space_federations.status = 'removed' then 'pending'
              else space_federations.status
            end,
            requested_by_did = excluded.requested_by_did,
            requested_at = excluded.requested_at,
            message = excluded.message
        `),
      ];
    }
    case "update": {
      const patch = change.record;
      return [
        global(sql`
          update space_federations set
            status = ${patch.status},
            decided_by_did = ${patch.decidedBy},
            decided_at = ${ctx.decidedAt},
            decision_message = ${patch.message}
          where space_id = ${ctx.streamId}
            and federating_space_did = ${change.rkey}
            and status = 'pending'
        `),
      ];
    }
    case "delete":
      // A removed relationship keeps its row so a later request can revive it.
      return [
        global(sql`
          update space_federations set
            status = 'removed',
            decided_by_did = ${ctx.actor},
            decided_at = ${ctx.decidedAt}
          where space_id = ${ctx.streamId}
            and federating_space_did = ${change.rkey}
        `),
      ];
  }
}

/**
 * The statements that apply one `federationGrant` change: the origin space's
 * ceiling for a receiving space. The record's repo is the origin space and its
 * key the receiving space.
 */
export function federationGrantStatements(
  change: FederationGrantChange,
): RuleStatement[] {
  if (change.op === "delete") {
    // `federation.remove` tears the relationship down, and the projection drops
    // both halves of what it granted: this space's origin ceiling and the
    // receiving space's grants against it. The receiver *record* is the
    // receiving space's own and is not deleted — only its effect here is.
    return [
      global(sql`
        delete from federation_room_permissions
        where space_id = ${change.repo}
          and federating_space_did = ${change.rkey}
      `),
      global(sql`
        delete from federation_receiver_permissions
        where space_id = ${change.repo}
          and federating_space_did = ${change.rkey}
      `),
    ];
  }

  if (change.op === "create") {
    // The adapter writes a grant as an update: a setter names one room, which
    // is a patch, not the whole record.
    throw new Error("federationGrant rule: a grant is created by an update");
  }
  const patch = change.record;
  const origin = change.repo;
  const receiving = change.rkey;

  return [
    global(sql`
      delete from federation_room_permissions
      where space_id = ${origin}
        and federating_space_did = ${receiving}
        and room_id = ${patch.room}
    `),
    ...(patch.permission === null
      ? []
      : [
          global(sql`
            insert into federation_room_permissions (
              space_id, federating_space_did, room_id, permission
            )
            values (${origin}, ${receiving}, ${patch.room}, ${patch.permission})
          `),
        ]),
  ];
}

/**
 * The statements that apply one `federationReceiverGrant` change: which of a
 * receiving space's members may see which of the origin space's rooms.
 *
 * The record's repo is the receiving space (the stream the event arrived on) and
 * its key the origin space, so the projection's `(space_id,
 * federating_space_did)` pair is the change's key and repo the other way round
 * from `federationGrant`.
 */
export function federationReceiverGrantStatements(
  change: FederationReceiverGrantChange,
): RuleStatement[] {
  const receiving = change.repo;
  const origin = change.rkey;

  if (change.op === "delete") {
    return [
      global(sql`
        delete from federation_receiver_permissions
        where space_id = ${origin}
          and federating_space_did = ${receiving}
      `),
    ];
  }

  if (change.op === "create") {
    // A receiver grant is set one grantee and one room at a time: the setter
    // names a single entry, which is a patch, not the whole record.
    throw new Error(
      "federationReceiverGrant rule: a grant is created by an update",
    );
  }

  const patch = change.record;
  return [
    global(sql`
      delete from federation_receiver_permissions
      where space_id = ${origin}
        and federating_space_did = ${receiving}
        and room_id = ${patch.room}
        and grantee = ${patch.grantee}
        and kind = ${patch.granteeKind}
    `),
    ...(patch.permission === null
      ? []
      : [
          global(sql`
            insert into federation_receiver_permissions (
              space_id, federating_space_did, room_id, grantee, kind, permission
            )
            values (
              ${origin}, ${receiving}, ${patch.room},
              ${patch.grantee}, ${patch.granteeKind}, ${patch.permission}
            )
          `),
        ]),
  ];
}
