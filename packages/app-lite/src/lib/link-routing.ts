/**
 * Where a clicked link should take the user — the whole decision, as a pure
 * function.
 *
 * In a Tauri webview the app's document is a bare webview with no browser
 * chrome, so a link that navigates the document in place strands the user on
 * the destination: no address bar, no back button. The shell therefore sends
 * `http(s)` links the app doesn't own out to the OS (system browser), while
 * space/room links — and everything else the app renders — stay in the
 * document.
 *
 * The same rule has to hold wherever a link is rendered: the markdown
 * renderer, `LinkCard`, `LinkViewItem`, `UserProfile`, `Button` with an
 * `href`, the marketing pages. Rather than repeat `target="_blank"` at each
 * (and miss the ones the renderer emits), the rule is evaluated at one point —
 * the delegated click handler in `external-link-handler.ts`, which calls this.
 * Keeping the rule separate from the DOM keeps it testable without a browser.
 */

import { parseInternalLinkHref } from "@roomy-space/sdk";

/** What to do with a clicked link. */
export type LinkAction =
  /** Leave the webview — hand the URL to the OS (system browser/mail/dialer). */
  | { kind: "external"; url: string }
  /** Navigate in-app to a space/room this client can look up. */
  | { kind: "internal"; path: string }
  /**
   * Let the document handle it. This covers the web build (whose browser gets
   * `http(s)`, `mailto:` and `_blank` right on its own), in-app routes on the
   * app's own origin, `hash`/`blob:` targets, and clicks the user aimed at a
   * new browsing context.
   */
  | { kind: "default" };

/** The schemes that hand off to an OS application rather than a page. */
const OS_HANDOFF_SCHEMES = ["mailto:", "tel:"];

export interface LinkClick {
  /**
   * The anchor's resolved `href` (`HTMLAnchorElement.href`), always absolute —
   * so a relative link is compared as a URL rather than string-matched.
   */
  href: string;
  /** Whether the anchor carries `download` (means "save", never "open"). */
  download: boolean;
  /**
   * Whether the click aimed at a new browsing context — a non-primary button
   * or a held modifier. Those intents ("open in background", "save", "new
   * window") belong to the platform; the shell's own opener plugin already
   * routes the ones it can, and re-implementing them here would either
   * double-open or lose the intent.
   */
  modifierClick: boolean;
  /** `true` inside the native shell (`__TAURI__` present), `false` on the web. */
  isShell: boolean;
  /** The document's origin (`window.location.origin`). */
  documentOrigin: string;
  /** The document's full URL, for telling an in-page fragment from a page. */
  documentUrl: string;
  /**
   * Origins an absolute link may be rooted at and still name a space/room this
   * client can look up — the same set the markdown renderer marks with
   * (`internalOriginsFor`).
   */
  internalOrigins: readonly string[];
}

/**
 * Decide where a link click goes.
 *
 * Space/room links resolve to an in-app path in **both** builds. The badge and
 * markdown paths render them as absolute URLs rooted at an internal origin
 * (under production, the appserver's web origin — not the document's), which
 * the platform would treat as an ordinary cross-origin navigation: the webview
 * would leave the app, and the web build would do a full page load. Re-rooting
 * at the relative path is what keeps that form in-app.
 */
export function routeLinkClick(click: LinkClick): LinkAction {
  const { href, documentOrigin, documentUrl, internalOrigins, isShell } = click;

  if (click.modifierClick || click.download) return { kind: "default" };

  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }

  // A `#fragment` pointing inside the current document is document state, not
  // a destination: following it should not leave the app.
  if (url?.hash) {
    try {
      const document = new URL(documentUrl);
      if (
        url.origin === documentOrigin &&
        url.pathname === document.pathname &&
        url.search === document.search
      ) {
        return { kind: "default" };
      }
    } catch {
      // A document URL that will not parse cannot be fragment-compared; fall
      // through to the normal rules.
    }
  }

  const target = parseInternalLinkHref(href, internalOrigins);
  if (target) {
    return {
      kind: "internal",
      path: `/${target.spaceId}${target.roomId ? `/${target.roomId}` : ""}`,
    };
  }

  // The web build's browser already handles every remaining case correctly.
  if (!isShell || !url) return { kind: "default" };

  if (OS_HANDOFF_SCHEMES.includes(url.protocol)) {
    return { kind: "external", url: url.href };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "default" };
  }
  // The app's own origin is the SPA's own routing — SvelteKit takes it.
  if (url.origin === documentOrigin) return { kind: "default" };

  return { kind: "external", url: url.href };
}
