/**
 * The signed-in user's own block set, and the message ids this session has
 * fetched as a reveal.
 *
 * Blocks live in the user's own repo (`space.roomy.user.block`), not in the
 * appserver, so the set is read from the PDS directly with `listBlocks` rather
 * than through the XRPC client — the same arrangement as the profile record.
 *
 * Neither set is an enforcement point. The server redacts a hidden author's
 * message on every read path, and `staleTime: Infinity` means a row fetched
 * *before* a block survives in the TanStack cache until the server sends a
 * diff or the query refetches. This module closes that window and answers the
 * one question the server cannot answer for the client: whether to *offer* a
 * reveal, which is a question about the viewer's own blocks.
 *
 * Only the viewer's own written blocks are here. The reverse direction (an
 * author who blocked the viewer) is not recoverable client-side; the server
 * sends a tombstone for it and the client renders what it is given.
 *
 * The revealed set is session-local and is never persisted, so a reload
 * returns the room to indicators — the client half of "the reveal is a read,
 * not a state".
 */

import { auth } from "$lib/auth.svelte";
import { listBlocks } from "$lib/mutations/blocks";

/** DIDs the viewer has blocked, read from the viewer's own repo. */
let ownBlockedDids = $state<ReadonlySet<string>>(new Set());

/** Message ids fetched as a reveal in this session; never persisted. */
let revealedMessageIds = $state<ReadonlySet<string>>(new Set());

/** The DID the current `ownBlockedDids` was loaded for, or null. */
let loadedFor: string | null = null;
/** In-flight load, so concurrent mounts share one PDS read. */
let inFlight: Promise<void> | null = null;

export const blockState = {
  /** DIDs the viewer has blocked. */
  get ownBlockedDids() {
    return ownBlockedDids;
  },
  /** Message ids the viewer has revealed in this session. */
  get revealedMessageIds() {
    return revealedMessageIds;
  },
};

/**
 * Load the viewer's own block set if it has not been loaded for this account
 * yet. Safe to call from every mount: one PDS read per signed-in session, and
 * a failure is not retried in a loop (the server's tombstones are what a
 * reader sees either way).
 */
export function ensureOwnBlocks(): void {
  const did = auth.userDid;
  if (!did) {
    ownBlockedDids = new Set();
    loadedFor = null;
    return;
  }
  if (loadedFor === did || inFlight) return;
  loadedFor = did;
  inFlight = listBlocks(did)
    .then((records) => {
      // A sign-out while the read was in flight left a set that belongs to
      // nobody; drop it rather than attribute one account's blocks to the
      // next.
      if (auth.userDid !== did) return;
      ownBlockedDids = new Set(records.map((r) => r.subject));
    })
    .catch((e) => {
      console.error("Failed to load the block list:", e);
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Record that a message arrived as a reveal, so its row renders in full. */
export function markRevealed(messageId: string): void {
  if (revealedMessageIds.has(messageId)) return;
  const next = new Set(revealedMessageIds);
  next.add(messageId);
  revealedMessageIds = next;
}
