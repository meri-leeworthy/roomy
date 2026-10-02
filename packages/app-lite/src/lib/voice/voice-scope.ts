/**
 * The scope decision behind the voice join button.
 *
 * Voice RPCs are deliberately outside the `base` tier (see `scopes.ts`): a
 * requestable `rpc:` scope must be registered on the deployed HappyView API
 * client, and requesting an unregistered one makes it reject the whole grant —
 * blocking sign-in for everyone. So a session on `base` cannot call the voice
 * RPCs, and the join button is where that is discovered and fixed.
 *
 * Pure, so the decision is testable without a session: `auth.svelte.ts` is the
 * reactive wrapper that supplies the granted scope string.
 */

import { hasScopeSet } from "../scopes.ts";

/**
 * True when joining a call needs the voice scope consented to first.
 *
 * A `null`/empty granted scope means "signed out or not yet introspected" and
 * is treated as lacking the tier, matching `auth.hasScope` — the two must agree
 * or the button and the guard would disagree about the same session.
 */
export function needsVoiceScopeConsent(grantedScope: string | null | undefined): boolean {
  if (!grantedScope || grantedScope.trim() === "") return true;
  return !hasScopeSet(grantedScope, "voice");
}
