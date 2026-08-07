/**
 * XRPC: space.roomy.space.joinSpace (procedure).
 *
 * Validates invite tokens for private spaces, appends the space-side
 * joinSpace event, and writes the `joinedSpace` edge directly so the
 * space is immediately visible in the caller's space list.
 *
 * @see packages/appserver/docs/plans/procedure-backlog.md
 */

import { newUlid, StreamDid, parseEvent } from "@roomy-space/sdk";
import { openDb, openGlobalDb } from "../db/db.ts";
import { getStreamManager } from "../streams/StreamManager.ts";
import { isBanned } from "../auth/access.ts";
import {
  JOINED_SPACE_LABEL,
  LEFT_SPACE_LABEL,
  recordPersonalSpaceMembership,
  removeLeftSpaceEdge,
  recordGlobalMembership,
  deleteGlobalMembership,
} from "../queries/joinedSpaces.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface JoinSpaceBody {
  spaceId?: unknown;
  inviteToken?: unknown;
}

interface JoinSpaceResult {
  spaceId: string;
}

export const joinSpaceHandler: ProcedureHandler<
  JoinSpaceBody,
  JoinSpaceResult
> = async (_params: QueryParams, auth: AuthCtx, body: JoinSpaceBody) => {
  // ── Validate input ───────────────────────────────────────────────────
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  if (
    body.inviteToken !== undefined &&
    typeof body.inviteToken !== "string"
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'inviteToken' must be a string if provided",
    );
  }

  const spaceId = body.spaceId;
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const db = openDb();

  // ── Verify space exists ──────────────────────────────────────────────
  const spaceRow = await db
    .query(
      "SELECT 1 AS n FROM entities WHERE id = ? LIMIT 1",
    )
    .get<{ n: number }>(spaceId);
  if (!spaceRow) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  // ── Ban check ────────────────────────────────────────────────────────
  if (await isBanned(db, spaceId, callerDid)) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is banned from this space",
    );
  }

  // ── Invite token validation for private spaces ───────────────────────
  const publicJoinRow = await db
    .query(
      "SELECT coalesce(allow_public_join, 1) AS v FROM comp_space WHERE entity = ?",
    )
    .get<{ v: number }>(spaceId);

  const isPrivate = publicJoinRow != null && publicJoinRow.v === 0;

  if (isPrivate) {
    if (!body.inviteToken) {
      throw new XrpcError(
        403,
        "Forbidden",
        "This space requires an invite token to join",
      );
    }
    const tokenRow = await db
    .query(
      "SELECT 1 AS n FROM comp_invite WHERE entity = ? AND token = ?",
    )
    .get<{ n: number }>(spaceId, body.inviteToken);
    if (!tokenRow) {
      throw new XrpcError(403, "Forbidden", "Invalid invite token");
    }
  }

  const streamManager = getStreamManager();

  // ── 1. Send space-side joinSpace event ───────────────────────────────
  const spaceJoinResult = parseEvent({
    id: newUlid(),
    $type: "space.roomy.space.joinSpace.v0",
    ...(body.inviteToken ? { inviteToken: body.inviteToken } : {}),
  });
  if (!spaceJoinResult.success) {
    throw new Error(`Failed to create joinSpace event: ${spaceJoinResult.error}`);
  }
  const spaceStreamDid = StreamDid.assert(spaceId);
  await streamManager.sendEvents(
    spaceStreamDid,
    [spaceJoinResult.data],
    callerDid,
  );

  // ── 2. Write joinedSpace edge directly ────────────────────────────────
  // The SDK materialiser (space.joinSpace) also writes this edge — routed
  // to the global DB — but the live materialisation may not have landed by
  // the time the HTTP response returns. Writing directly to both the
  // monolithic DB (Phase-1 read source) and the global DB (membership store)
  // makes the space immediately visible and keeps the global DB consistent.
  await recordPersonalSpaceMembership(db, spaceStreamDid, callerDid);
  await recordGlobalMembership(
    openGlobalDb(),
    spaceStreamDid,
    callerDid,
    JOINED_SPACE_LABEL,
  );

  // ── 3. Remove any leftSpace edge since the user is now rejoined ────
  await removeLeftSpaceEdge(db, spaceStreamDid, callerDid);
  await deleteGlobalMembership(
    openGlobalDb(),
    spaceStreamDid,
    callerDid,
    LEFT_SPACE_LABEL,
  );

  // ── 4. Emit direct getSpaces + getMetadata invalidation signals ──────
  // The live materializer also emits these when it processes the
  // joinSpace event, but that delivery is asynchronous and may race with
  // the HTTP response. Emitting directly for the caller closes the race.
  const router = InvalidationRouter.getInstance();
  if (router) {
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
          affectedUser: callerDid,
        },
      },
      // getMetadata returns isMember/isAdmin, which flips to true on join.
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId },
          affectedUser: callerDid,
        },
      },
    ]);
  }

  return { spaceId };
};
