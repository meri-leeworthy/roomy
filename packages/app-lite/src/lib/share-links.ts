/**
 * The live shareable-link builders: the pure rules in `share-url.ts` resolved
 * against this build's config and this document.
 *
 * The origin is resolved once, at module load. `config.ts` is where
 * `PUBLIC_WEB_ORIGIN`/`VITE_PUBLIC_WEB_ORIGIN` are read, so importing the
 * builders from here — rather than reaching for `location.origin` at a call
 * site — is what keeps a webview's `tauri://localhost` out of a shared link.
 */
import { CONFIG } from "./config";
import {
  inviteUrl as buildInviteUrl,
  resolveShareOrigin,
  shareUrl as reRoot,
} from "./share-url";

const SHARE_ORIGIN = resolveShareOrigin(
  CONFIG.publicWebOrigin,
  typeof location !== "undefined" ? location.origin : "",
  CONFIG.publicWebOriginMarker,
);

/** A same-document URL re-rooted at the public web origin — see `share-url.ts`. */
export function shareUrl(base: URL | string): URL {
  return reRoot(SHARE_ORIGIN, base);
}

/** The shareable invite link for `token` — see `share-url.ts`. */
export function inviteUrl(spaceId: string, token: string): string {
  return buildInviteUrl(SHARE_ORIGIN, spaceId, token);
}
