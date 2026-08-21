/**
 * XRPC: space.roomy.space.sendEvents (procedure).
 *
 * Sends a batch of Roomy events to a space stream through the appserver.
 * The appserver validates authorization per-event, then writes events directly
 * to the events DB and materializes inline.
 *
 * @see packages/appserver/docs/plans/sendEvents-procedure.md
 */

import { parseEvent, type Event, StreamDid } from "@roomy-space/sdk";
import { log } from "../log.ts";
import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { checkWriteAuth } from "../auth/writeAuth.ts";
import { spaceAccess } from "../auth/access.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";
import {
  getStreamManager,
  SpaceRematerializingError,
} from "../streams/StreamManager.ts";

const MAX_BATCH_SIZE = 50;

interface SendEventsBody {
  spaceId?: unknown;
  events?: unknown;
}

export const sendEventsHandler: ProcedureHandler<SendEventsBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: SendEventsBody,
) => {
  // 1. Validate input
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: events",
    );
  }
  if (body.events.length > MAX_BATCH_SIZE) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Too many events: max ${MAX_BATCH_SIZE}`,
    );
  }

  const spaceId = body.spaceId;
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  log.info("sendEvents", { spaceId, callerDid, count: body.events.length });
  const db = openSpaceDb(spaceId);
  // Space access is resolved here (for writeAuth + to reject banned callers)
  // but NOT treated as a hard gate: a caller who is not a member/admin of the
  // target space may still be a member of a *federated* space and authorized
  // to write to a federated channel. Per-event `writeAuth` is the sole
  // authority on what the caller may send — it denies events that require
  // membership/admin and allows federated room writes.
  const access = await spaceAccess(db, spaceId, callerDid);
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }

  // 3. Validate + authorize each event
  const parsedEvents: (typeof Event.infer)[] = [];
  for (let i = 0; i < body.events.length; i++) {
    const raw = body.events[i];
    if (typeof raw !== "object" || raw === null) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        `Event at index ${i} is not an object`,
      );
    }
    const parsed = parseEvent(raw);
    if (!parsed.success) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        `Event at index ${i} is invalid: ${parsed.error}`,
      );
    }
    const event = parsed.data;
    const denial = await checkWriteAuth(
      db,
      spaceId,
      callerDid,
      event,
      access,
      openSpaceDb,
      openGlobalDb(),
    );
    if (denial) {
      throw new XrpcError(
        denial.status,
        denial.error,
        denial.message,
      );
    }
    parsedEvents.push(event);
  }
  log.debug("sendEvents", "validated", { spaceId, count: parsedEvents.length });

  // 4. Write to events DB + materialize inline
  const streamManager = getStreamManager();
  log.info("sendEvents", "writing to events DB", { spaceId, count: parsedEvents.length });
  const streamDid = StreamDid.assert(spaceId);
  try {
    await streamManager.sendEvents(streamDid, parsedEvents, callerDid);
  } catch (err) {
    // Blue-green (P2/P8): a write to a space that is currently being rebuilt
    // is rejected before it lands in the event log. Surface it as a retryable
    // 409 so clients can back off and retry once the rebuild commits — not a
    // 500 (the write is safe to retry; nothing was applied).
    if (err instanceof SpaceRematerializingError) {
      throw new XrpcError(
        409,
        "SpaceRematerializing",
        `Space ${spaceId} is being rematerialized; retry the write shortly`,
      );
    }
    throw err;
  }

  log.info("sendEvents", "done", { spaceId, count: parsedEvents.length });
};
