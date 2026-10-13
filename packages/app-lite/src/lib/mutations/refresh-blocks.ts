/**
 * Tell the appserver a block set changed, so it re-reads the caller's repos.
 *
 * The appserver caches each account's resolved block set for a minute, so
 * without this the server would keep handing out a just-blocked author's
 * content until that cache expired — the client can stop rendering them at
 * once, but the enforcement lives on the server.
 *
 * Fire-and-forget: the block record is already in the user's repo by the time
 * this is called, and it is the repo that is the source of truth. A failure here
 * costs at most the cache's own TTL, so it must never surface as a failed block.
 */

import { px } from "$lib/auth.svelte";

/** Re-read the caller's blocks; `subject` also drops that account's cached set. */
export async function refreshBlocks(subject?: string): Promise<void> {
  await px().procedure("space.roomy.user.refreshBlocks", {
    ...(subject ? { subject } : {}),
  });
}

/**
 * Fire-and-forget {@link refreshBlocks}.
 *
 * Swallows rejections rather than letting them escape: this runs in the
 * background of a write that has already succeeded, and an unhandled rejection
 * there would be noise attached to a successful action.
 */
export function refreshBlocksDetached(subject?: string): void {
  void refreshBlocks(subject).catch((err) => {
    console.warn("refreshBlocks failed", err);
  });
}
