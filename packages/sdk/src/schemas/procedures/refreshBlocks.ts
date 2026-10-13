/**
 * Schema for `space.roomy.user.refreshBlocks` (procedure, authenticated).
 * Source of truth: packages/appserver/src/handlers/space.roomy.user.refreshBlocks.ts
 *
 * Re-reads the caller's block records from their own repos and stores the
 * resolved set, so a block or unblock takes effect on the next read rather than
 * at the next cache expiry. The client calls it after a block write succeeds;
 * a failure is non-fatal, because the write to the PDS already succeeded and the
 * cache's own TTL converges without it.
 *
 * Takes no body beyond the block's `subject`: the account to refresh is the
 * authenticated caller, and the subject is the other party of the block, whose
 * cached set the write also changes.
 */
import { type } from "arktype";

export const NSID = "space.roomy.user.refreshBlocks" as const;

export const Input = type({
  /**
   * DID of the account whose cached block set also has to be dropped. A block
   * hides in both directions, so writing *or* removing one changes what that
   * account's own set resolves to — on a block the caller joins their
   * `blockedBy`, on an unblock the caller leaves it. Omitting it refreshes the
   * caller alone.
   */
  "subject?": "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
