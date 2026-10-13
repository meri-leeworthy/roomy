/**
 * XRPC: space.roomy.user.refreshBlocks (procedure).
 *
 * Re-reads the caller's block records from their own repos and stores the
 * resolved set, so a block or unblock takes effect on the next read instead of
 * at the next cache expiry. Without it, a block the user has just written stays
 * unenforced on the server for up to the cache TTL — the client can stop
 * rendering the author at once, but the read paths still hand the content out.
 *
 * The body names the block's `subject`. A block hides in both directions, so
 * writing or removing one changes what the *subject's* own set resolves to — on
 * a block the caller joins their recovered blockers, on an unblock the caller
 * leaves it. Leaving that cached would keep the direction open for the rest of
 * its TTL.
 *
 * Both invalidations are cheap and neither is a fetch: dropping a memo entry
 * makes the next read re-resolve, and the network work happens there, detached.
 * The writer's own refresh is awaited so the caller's next request already sees
 * the new set.
 *
 * Fire-and-forget on the client — the write to the PDS has already succeeded,
 * and a failure here self-heals at the next TTL expiry.
 */

import { type } from "arktype";
import { UserDid } from "@roomy-space/sdk";
import { invalidateBlockSet, refreshBlockSet } from "../queries/userBlocks.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RefreshBlocksBody {
  subject?: unknown;
}

export const refreshBlocksHandler: ProcedureHandler<
  RefreshBlocksBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: RefreshBlocksBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  // The subject only ever names a cache to drop, so an unparseable value is a
  // 400 rather than a silently ignored field: it means the client sent
  // something other than a DID, and the mutual invalidations it expects would
  // not have happened.
  const subject =
    body.subject === undefined ? null : UserDid(body.subject);
  if (subject instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Invalid block subject: ${subject.summary}`,
    );
  }

  await refreshBlockSet(userDid);
  if (subject !== null) invalidateBlockSet(subject);
};
