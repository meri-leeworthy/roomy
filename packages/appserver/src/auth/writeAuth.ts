/**
 * Per-event write authorization for the `sendEvents` procedure.
 *
 * Self-contained, decision-only module — same coupling rules as `access.ts`:
 *   - No imports from `src/xrpc/`, `src/handlers/`, `src/hydration/`.
 *   - No `XrpcError`, no HTTP status codes, no logging.
 *
 * Returns `undefined` for "allowed" or a `{ status, error, message }` denial.
 * The handler layer translates denials into XrpcErrors.
 */

import type { DbLike } from "../db/types.ts";
import {
  spaceAccess,
  roomAccess,
  isAdmin,
  isMember,
  isBanned,
  type SpaceAccess,
} from "./access.ts";
import { federatedRoomAccess } from "./federation.ts";

// ── Result type ──────────────────────────────────────────────────────────

export interface WriteAuthDenial {
  status: 400 | 403 | 404 | 409;
  error: string;
  message: string;
}

export type WriteAuthResult = undefined | WriteAuthDenial;

// ── Allow list / reject set ──────────────────────────────────────────────

/**
 * Event types that must NOT be sent through this endpoint.
 * They target the personal stream or have been replaced by dedicated XRPCs.
 */
const REJECTED_TYPES = new Set([
  "space.roomy.state.markRead.v0",
]);

/**
 * All known event types that are allowed through this endpoint.
 * Built from the SDK's event registry keys minus rejected types.
 */
const ALLOWED_TYPES: Set<string> = new Set([
  // Room write
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.link.removeRoomLink.v0",
  // Room manage
  "space.roomy.room.createRoom.v0",
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
  // Space manage
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.deleteRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.page.editPage.v0",
  "space.roomy.openmeet.configure.v0",
  // Space member
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.space.createInvite.v0",
  // Bridged
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
  // Channel federation (relationship lifecycle)
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
]);

// ── Auth category dispatch ───────────────────────────────────────────────

/**
 * Room-write events — require `roomAccess(db, event.room, did).canWrite`
 * AND space membership (already encoded in `canWrite`).
 */
const ROOM_WRITE_TYPES = new Set([
  "space.roomy.message.createMessage.v0",
  "space.roomy.message.moveMessages.v0",
  "space.roomy.message.reorderMessage.v0",
  "space.roomy.message.forwardMessages.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.link.createRoomLink.v0",
  "space.roomy.link.removeRoomLink.v0",
]);

/**
 * Room-write events that additionally require author-or-admin check.
 */
const MESSAGE_AUTHOR_TYPES = new Set([
  "space.roomy.message.editMessage.v0",
  "space.roomy.message.deleteMessage.v0",
]);

/**
 * Room management events — require space admin.
 *
 * `createRoom.v0` is handled specially below (split by `kind`): creating a
 * thread room is allowed for any space member, with the actual
 * "write access to the parent channel" enforced by the paired
 * `space.roomy.link.createRoomLink.v0` event (in ROOM_WRITE_TYPES, gated on
 * `canWrite` of the target channel). Creating channels/pages, and
 * updating/deleting/restoring any room, still require space admin.
 */
const ROOM_MANAGE_TYPES = new Set([
  "space.roomy.room.updateRoom.v0",
  "space.roomy.room.deleteRoom.v0",
  "space.roomy.room.restoreRoom.v0",
]);

/**
 * Space management events — require space admin.
 */
const SPACE_MANAGE_TYPES = new Set([
  "space.roomy.space.updateSpaceInfo.v0",
  "space.roomy.space.updateSidebar.v0",
  "space.roomy.space.updateSidebar.v1",
  "space.roomy.space.setHandleProvider.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.space.banAccount.v0",
  "space.roomy.space.unbanAccount.v0",
  "space.roomy.role.createRole.v0",
  "space.roomy.role.deleteRole.v0",
  "space.roomy.role.updateRole.v0",
  "space.roomy.role.addMemberRole.v0",
  "space.roomy.role.removeMemberRole.v0",
  "space.roomy.role.setRoleRoomPermission.v0",
  "space.roomy.space.revokeInvite.v0",
  "space.roomy.page.editPage.v0",
  "space.roomy.openmeet.configure.v0",
]);

/**
 * Space member events — require membership (not banned).
 */
const SPACE_MEMBER_TYPES = new Set([
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.user.updateProfile.v0",
  "space.roomy.space.createInvite.v0",
]);

/**
 * Bridged events — require space admin.
 */
const BRIDGED_TYPES = new Set([
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
]);

/**
 * Channel-federation relationship events.
 *
 * `respond`/`remove` target the origin space (A) and require an A admin.
 * `request` is sent on A's stream but originates from space B: the caller
 * must be an admin of B AND a member of A (the federation precondition).
 * Resolving admin-of-B requires the *other* space's DB handle, supplied via
 * the optional `dbResolver` so this module stays pure and testable.
 */
const FEDERATION_TYPES = new Set([
  "space.roomy.federation.request.v0",
  "space.roomy.federation.respond.v0",
  "space.roomy.federation.remove.v0",
  "space.roomy.federation.setRoomPermission.v0",
  "space.roomy.federation.setReceiverPermission.v0",
]);

// ── Helper: denial constructors ──────────────────────────────────────────

function denied(
  status: 400 | 403 | 404 | 409,
  error: string,
  message: string,
): WriteAuthDenial {
  return { status, error, message };
}

// ── Auth check helpers ───────────────────────────────────────────────────
async function requireSpaceAdminCheck(
  db: DbLike,
  spaceId: string,
  did: string,
  access?: SpaceAccess,
): Promise<WriteAuthResult> {
  const admin = access ? access.isAdmin : await isAdmin(db, spaceId, did);
  if (!admin) {
    return denied(403, "Forbidden", "Caller is not a space admin");
  }
  return undefined;
}

async function requireMembershipCheck(
  db: DbLike,
  spaceId: string,
  did: string,
  access?: SpaceAccess,
): Promise<WriteAuthResult> {
  const a = access ?? await spaceAccess(db, spaceId, did);
  if (a.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!a.isMember && !a.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not a member of this space",
    );
  }
  return undefined;
}

async function requireNotBannedCheck(
  db: DbLike,
  spaceId: string,
  did: string,
  access?: SpaceAccess,
): Promise<WriteAuthResult> {
  const banned = access ? access.isBanned : await isBanned(db, spaceId, did);
  if (banned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  return undefined;
}


async function requireRoomWriteCheck(
  db: DbLike,
  roomId: string,
  did: string,
  globalDb?: DbLike,
  dbResolver?: (spaceDid: string) => DbLike,
): Promise<WriteAuthResult> {
  const access = await roomAccess(db, roomId, did);
  if (!access.exists) {
    return denied(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (access.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (access.canWrite) return undefined;

  // Federation fallback (Phase 3): a member of a federated receiving space
  // may write when both the origin and receiver grants allow it.
  if (globalDb && dbResolver) {
    const fed = await federatedRoomAccess(db, globalDb, roomId, did, {
      spaceDbResolver: dbResolver,
    });
    if (fed && fed.canWrite) return undefined;
  }
  return denied(
    403,
    "Forbidden",
    "Caller does not have write access to this room",
  );
}

/**
 * For editMessage/deleteMessage: the caller must be the original author
 * OR a space admin.
 */

async function checkMessageAuthorOrAdmin(
  db: DbLike,
  messageId: string,
  callerDid: string,
  spaceId: string,
): Promise<WriteAuthResult> {
  const admin = await isAdmin(db, spaceId, callerDid);
  if (admin) return undefined;

  const row = await db.query("SELECT tail FROM edges WHERE head = ? AND label = 'author' LIMIT 1").get<{ tail: string }>([messageId]);
  if (!row || row.tail !== callerDid) {
    return denied(
      403,
      "Forbidden",
      "Only the message author or a space admin can edit/delete this message",
    );
  }
  return undefined;
}

/**
 * Authorize a federation request sent on space A's stream by an admin of
 * space B. Requires: caller is a member (or admin) of the origin space A,
 * AND caller is an admin of the requesting space B (resolved via the
 * cross-space `dbResolver`). The member-of-A precondition is the documented
 * federation rule; admin-of-B ensures only B's admins can initiate.
 */
async function checkFederationRequest(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  access?: SpaceAccess,
  dbResolver?: (spaceDid: string) => DbLike,
  globalDb?: DbLike,
): Promise<WriteAuthResult> {
  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid !== "string" || federatingSpaceDid === "") {
    return denied(
      400,
      "InvalidRequest",
      `Event is missing required 'federatingSpaceDid' field`,
    );
  }

  // Caller must be a member (or admin) of the origin space A.
  const a = access ?? (await spaceAccess(db, spaceId, callerDid));
  if (a.isBanned) {
    return denied(403, "Forbidden", "Caller is banned from this space");
  }
  if (!a.isMember && !a.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not a member of the target space",
    );
  }

  // Caller must be an admin of the requesting space B (cross-space).
  if (!dbResolver) {
    // Unreachable via sendEvents (which always passes openSpaceDb); defensive
    // fallback for callers that don't provide a cross-space resolver.
    return denied(
      403,
      "Forbidden",
      "Federation request requires a cross-space access check that is not configured",
    );
  }
  const bDb = dbResolver(federatingSpaceDid);
  const b = await spaceAccess(bDb, federatingSpaceDid, callerDid);
  if (!b.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Caller is not an admin of the requesting space",
    );
  }

  // Guard against a duplicate request: there must be no existing *live* or
  // already-decided federation for this (A, B) pair that can't be re-opened.
  // A re-request while a request is already pending is an idempotent no-op
  // (the materializer keeps it pending). A re-request after the federation was
  // removed re-establishes it (the materializer flips 'removed' back to
  // 'pending') — this is the recovery path for a torn-down federation.
  // Requesting while active/rejected is an error so the requesting admin
  // doesn't think their request will be reconsidered.
  if (globalDb) {
    const existing = await globalDb
      .query(
        "select status from space_federations where space_id = ? and federating_space_did = ?",
      )
      .get<{ status: string }>(spaceId, federatingSpaceDid);
    if (
      existing &&
      (existing.status === "active" || existing.status === "rejected")
    ) {
      return denied(
        409,
        "Conflict",
        `A federation with this space already exists (status: ${existing.status})`,
      );
    }
  }

  return undefined;
}

/**
 * Authorize a federation removal. The relationship can be torn down by an
 * admin of either side: an admin of the origin space A, or an admin of the
 * receiving space B (B may revoke its own membership at any time). `remove`
 * is sent on A's stream, so `spaceId` is A and the B-admin check needs the
 * cross-space `dbResolver`.
 */
async function checkFederationRemove(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  access?: SpaceAccess,
  dbResolver?: (spaceDid: string) => DbLike,
): Promise<WriteAuthResult> {
  // Admin of the origin space A.
  const a = access ?? (await spaceAccess(db, spaceId, callerDid));
  if (a.isAdmin) return undefined;

  // Admin of the receiving space B (cross-space).
  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid === "string" && federatingSpaceDid !== "" && dbResolver) {
    const bDb = dbResolver(federatingSpaceDid);
    const b = await spaceAccess(bDb, federatingSpaceDid, callerDid);
    if (b.isAdmin) return undefined;
  }

  return denied(
    403,
    "Forbidden",
    "Only an admin of this space or the federated space can remove the federation",
  );
}

/**
 * Authorize a federation respond (approve/reject). Requires an admin of the
 * origin space A, and restricts the decision to a request that is actually
 * awaiting a decision. Responding to a federation that doesn't exist (404) or
 * isn't pending (409 — e.g. already active/rejected/removed) is rejected so
 * the A admin can't accidentally orphan grants (rejecting an active
 * federation) or resurrect a removed one (approving it back to active). This
 * mirrors the guard the materializer's `status = 'pending'` predicate.
 */
async function checkFederationRespond(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  access?: SpaceAccess,
  globalDb?: DbLike,
): Promise<WriteAuthResult> {
  // Admin of the origin space A (decisions are A's to make).
  const a = access ?? (await spaceAccess(db, spaceId, callerDid));
  if (!a.isAdmin) {
    return denied(
      403,
      "Forbidden",
      "Only an admin of this space can respond to a federation request",
    );
  }

  const federatingSpaceDid = event.federatingSpaceDid;
  if (typeof federatingSpaceDid !== "string" || federatingSpaceDid === "") {
    return denied(
      400,
      "InvalidRequest",
      `Event is missing required 'federatingSpaceDid' field`,
    );
  }

  if (globalDb) {
    const existing = await globalDb
      .query(
        "select status from space_federations where space_id = ? and federating_space_did = ?",
      )
      .get<{ status: string }>(spaceId, federatingSpaceDid);
    if (!existing) {
      return denied(
        404,
        "NotFound",
        "No federation request from this space to respond to",
      );
    }
    if (existing.status !== "pending") {
      return denied(
        409,
        "Conflict",
        `Cannot respond to a federation with status: ${existing.status}`,
      );
    }
  }

  return undefined;
}

/**
 * Authorize a receiver-grant write (`setReceiverPermission`, sent on B's
 * stream). Requires a B admin (via requireSpaceAdminCheck) and — when *setting*
 * a grant (permission != null) — verifies that the origin space A has actually
 * exposed the channel to B through an active origin grant. A receiver grant
 * is meaningless (and inert) without that origin grant, so blocking it
 * prevents admins from creating stale rows they can't act on. Clearing a grant
 * (permission == null) is always allowed so admins can clean up stale entries.
 */
async function checkSetReceiverPermission(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  access?: SpaceAccess,
  globalDb?: DbLike,
): Promise<WriteAuthResult> {
  // B admin of the receiving space (spaceId === B).
  const adminResult = await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  if (adminResult) return adminResult;

  const originSpaceId = event.originSpaceId;
  const roomId = event.roomId;
  if (typeof originSpaceId !== "string" || originSpaceId === "") {
    return denied(400, "InvalidRequest", `Event is missing required 'originSpaceId' field`);
  }
  if (typeof roomId !== "string" || roomId === "") {
    return denied(400, "InvalidRequest", `Event is missing required 'roomId' field`);
  }

  // Granting (non-null) requires the origin grant to exist and be active.
  if (event.permission === null || event.permission === undefined) return undefined;
  if (!globalDb) return undefined; // defensive: no global DB -> skip origin check

  const exposed = await globalDb
    .query(
      `select 1
         from space_federations sf
         join federation_room_permissions frp
           on frp.space_id = sf.space_id
          and frp.federating_space_did = sf.federating_space_did
        where sf.space_id = ?
          and sf.federating_space_did = ?
          and sf.status = 'active'
          and frp.room_id = ?`,
    )
    .get<{ n: number }>(originSpaceId, spaceId, roomId);
  if (!exposed) {
    return denied(
      409,
      "Conflict",
      "Origin space has not exposed this channel to your space",
    );
  }

  return undefined;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Check whether the caller is authorized to send a single event.
 *
 * `dbResolver`, when provided, returns the DB handle for another space by
 * DID — used only for the federation-request cross-space admin-of-B check.
 *
 * @returns `undefined` if allowed, or a denial object.
 */
export async function checkWriteAuth(
  db: DbLike,
  spaceId: string,
  callerDid: string,
  event: { $type: string; [k: string]: unknown },
  access?: SpaceAccess,
  dbResolver?: (spaceDid: string) => DbLike,
  globalDb?: DbLike,
): Promise<WriteAuthResult> {
  const { $type } = event;

  // Reject banned types
  if (REJECTED_TYPES.has($type)) {
    return denied(
      400,
      "InvalidRequest",
      `Event type ${$type} is not accepted by this endpoint`,
    );
  }

  // Unknown types
  if (!ALLOWED_TYPES.has($type)) {
    return denied(
      400,
      "InvalidRequest",
      `Unknown event type: ${$type}`,
    );
  }

  // ── Room write ──
  if (ROOM_WRITE_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    return await requireRoomWriteCheck(db, roomId, callerDid, globalDb, dbResolver);
  }

  // ── Room write + author check (edit/delete) ──
  if (MESSAGE_AUTHOR_TYPES.has($type)) {
    const roomId = event.room;
    if (typeof roomId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'room' field`);
    }
    const roomResult = await requireRoomWriteCheck(db, roomId, callerDid, globalDb, dbResolver);
    if (roomResult) return roomResult;

    // Additional author-or-admin check
    const messageId = event.messageId;
    if (typeof messageId !== "string") {
      return denied(400, "InvalidRequest", `Event is missing required 'messageId' field`);
    }
    return await checkMessageAuthorOrAdmin(db, messageId, callerDid, spaceId);
  }

  // ── Room creation (split by kind) ──
  // Thread rooms may be created by any space member; the actual "write
  // access to the parent channel" is enforced by the paired
  // `space.roomy.link.createRoomLink.v0` event (ROOM_WRITE_TYPES), which is
  // gated on `canWrite` of the target channel and rejected atomically in the
  // same batch if the caller lacks write access. Channels/pages still
  // require space admin.
  if ($type === "space.roomy.room.createRoom.v0") {
    if (event.kind === "space.roomy.thread") {
      return await requireMembershipCheck(db, spaceId, callerDid, access);
    }
    return await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  }

  // ── Room manage ──
  if (ROOM_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  }

  // ── Space manage ──
  if (SPACE_MANAGE_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  }

  // ── Space member ──
  if (SPACE_MEMBER_TYPES.has($type)) {
    // joinSpace only requires "not banned"
    if ($type === "space.roomy.space.joinSpace.v0") {
      return await requireNotBannedCheck(db, spaceId, callerDid, access);
    }
    return await requireMembershipCheck(db, spaceId, callerDid, access);
  }

  // ── Bridged ──
  if (BRIDGED_TYPES.has($type)) {
    return await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  }

  // ── Channel federation ──
  if (FEDERATION_TYPES.has($type)) {
    if ($type === "space.roomy.federation.request.v0") {
      return await checkFederationRequest(db, spaceId, callerDid, event, access, dbResolver, globalDb);
    }
    if ($type === "space.roomy.federation.respond.v0") {
      return await checkFederationRespond(db, spaceId, callerDid, event, access, globalDb);
    }
    if ($type === "space.roomy.federation.setReceiverPermission.v0") {
      return await checkSetReceiverPermission(db, spaceId, callerDid, event, access, globalDb);
    }
    // remove may be initiated by an admin of either side (A or B);
    // setRoomPermission targets the origin space (A) and requires an A admin.
    if ($type === "space.roomy.federation.remove.v0") {
      return await checkFederationRemove(db, spaceId, callerDid, event, access, dbResolver);
    }
    return await requireSpaceAdminCheck(db, spaceId, callerDid, access);
  }

  // Should be unreachable if ALLOWED_TYPES and the dispatch tables agree
  return denied(400, "InvalidRequest", `Unhandled event type: ${$type}`);
}

/**
 * The full set of allowed `$type` values. Exported for testing/validation.
 */
export { ALLOWED_TYPES, REJECTED_TYPES };
