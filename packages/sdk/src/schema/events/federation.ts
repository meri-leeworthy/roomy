/**
 * Channel-federation events: request, approve/reject, remove.
 *
 * Federation lets a channel in space A be exposed to space B. These events
 * are the relationship-lifecycle half of that feature (Phases 1 of
 * packages/appserver/docs/plans/channel-federation.md): they establish,
 * accept, and tear down the A<->B relationship. Per-channel origin/receiver
 * grants are later phases.
 *
 * All three events target the *origin* space (A) stream. The materializers
 * write to the global `space_federations` registry, which the appserver
 * routes to the global DB.
 */

import { StreamDid, Ulid, type } from "../primitives";
import { defineEvent } from "./utils";
import { sql } from "../../utils";

const FederationRequestSchema = type({
  $type: "'space.roomy.federation.request.v0'",
  federatingSpaceDid: StreamDid.describe(
    "The space (B) requesting to federate into this space (A).",
  ),
  "message?": type("string").describe(
    "Optional note from the requesting admin to the receiving admins.",
  ),
}).describe(
  "Request that the sending space (B) be federated into this space (A). " +
    "Sent on A's stream by an admin of B who is also a member of A.",
);

export const FederationRequest = defineEvent(
  FederationRequestSchema,
  ({ streamId, user, event }) => [
    sql`
      insert into space_federations (
        space_id, federating_space_did, status,
        requested_by_did, requested_at, message
      )
      values (${streamId}, ${event.federatingSpaceDid}, 'pending', ${user}, ${Date.now()}, ${event.message ?? null})
      on conflict(space_id, federating_space_did) do update set
        status = case
          when space_federations.status = 'removed' then 'pending'
          else space_federations.status
        end,
        requested_by_did = excluded.requested_by_did,
        requested_at = excluded.requested_at,
        message = excluded.message
    `,
  ],
);

const FederationRespondSchema = type({
  $type: "'space.roomy.federation.respond.v0'",
  federatingSpaceDid: StreamDid.describe(
    "The space (B) whose pending request is being decided.",
  ),
  approve: type("boolean").describe(
    "true to accept the federation, false to reject it.",
  ),
  "message?": type("string").describe(
    "Optional note to the requesting admins about the decision.",
  ),
}).describe(
  "Approve or reject a federation request. Sent on A's stream by an admin of A.",
);

export const FederationRespond = defineEvent(
  FederationRespondSchema,
  ({ streamId, user, event }) => [
    sql`
      update space_federations set
        status = ${event.approve ? "active" : "rejected"},
        decided_by_did = ${user},
        decided_at = ${Date.now()},
        decision_message = ${event.message ?? null}
      where space_id = ${streamId}
        and federating_space_did = ${event.federatingSpaceDid}
    `,
  ],
);

const FederationRemoveSchema = type({
  $type: "'space.roomy.federation.remove.v0'",
  federatingSpaceDid: StreamDid.describe(
    "The space (B) whose federation with this space is being removed.",
  ),
}).describe(
  "Remove an existing federation. Sent on A's stream by an admin of A. " +
    "Any per-channel grants for B are dropped by the appserver.",
);

export const FederationRemove = defineEvent(
  FederationRemoveSchema,
  ({ streamId, user, event }) => [
    sql`
      update space_federations set
        status = 'removed',
        decided_by_did = ${user},
        decided_at = ${Date.now()}
      where space_id = ${streamId}
        and federating_space_did = ${event.federatingSpaceDid}
    `,
  ],
);

const SetRoomPermissionSchema = type({
  $type: "'space.roomy.federation.setRoomPermission.v0'",
  federatingSpaceDid: StreamDid.describe(
    "The receiving space (B) whose access to this channel is being set.",
  ),
  roomId: Ulid.describe(
    "The channel in this space (A) to grant access to. Threads inherit from " +
      "their parent channel, so grants are channel-scoped.",
  ),
  permission: type("'read' | 'readwrite'")
    .or(type.null)
    .describe(
      "The origin grant level for B on this channel. null removes B's access.",
    ),
}).describe(
  "Set (or clear) the origin grant: what access the receiving space B has to " +
    "a channel of this space (A). Sent on A's stream by an admin of A.",
);

export const SetRoomPermission = defineEvent(
  SetRoomPermissionSchema,
  ({ streamId, event }) => [
    // Remove any existing grant unconditionally, then re-insert if non-null.
    sql`
      delete from federation_room_permissions
       where space_id = ${streamId}
         and federating_space_did = ${event.federatingSpaceDid}
         and room_id = ${event.roomId}
    `,
    ...(event.permission !== null
      ? [
          sql`
            insert into federation_room_permissions (
              space_id, federating_space_did, room_id, permission
            )
            values (${streamId}, ${event.federatingSpaceDid}, ${event.roomId}, ${event.permission})
          `,
        ]
      : []),
  ],
);

export const FederationEventVariant = type.or(
  FederationRequestSchema,
  FederationRespondSchema,
  FederationRemoveSchema,
  SetRoomPermissionSchema,
);
