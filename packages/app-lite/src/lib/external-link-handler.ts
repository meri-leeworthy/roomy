/**
 * The one place a link click is routed, and the one place a URL is handed to
 * the OS.
 *
 * Every link the app renders goes through the listener installed here — the
 * markdown renderer's, `LinkCard`'s, `Button`'s, the marketing pages' — so no
 * call site has to know that a webview cannot navigate to an external page
 * without stranding the user. The decision itself lives in `link-routing.ts`;
 * this module only touches the DOM and the shell's opener plugin.
 *
 * A no-op on the web build, where the browser's own handling is correct.
 */

import { goto } from "$app/navigation";
import { CONFIG } from "$lib/config";
import { internalOriginsFor } from "$lib/internal-link-origins";
import { routeLinkClick } from "$lib/link-routing";

/** The opener surface the shell installs on `window.__TAURI__`. */
type ShellOpener = { openUrl(url: string): Promise<void> };

/** The shell's opener, or `null` on the web build. */
function shellOpener(): ShellOpener | null {
  if (typeof window === "undefined" || !("__TAURI__" in window)) return null;
  const tauri = window.__TAURI__ as { opener?: ShellOpener } | undefined;
  const openUrl = tauri?.opener?.openUrl;
  if (typeof openUrl !== "function") return null;
  return tauri!.opener!;
}

/**
 * Hand a URL to the OS: the system browser for `http(s)`, the mail client for
 * `mailto:`, the dialer for `tel:`.
 *
 * Returns `false` when there is no shell to ask (the web build, or a shell
 * whose opener global is missing), so a caller with a URL that must go
 * somewhere can fall back to navigating. A rejected open (the shell's opener
 * ACL refuses the scheme) also falls back, rather than failing silently.
 */
export function openExternal(url: string): boolean {
  const opener = shellOpener();
  if (!opener) return false;

  void opener.openUrl(url).catch((err: unknown) => {
    console.warn("[link-routing] opener refused, navigating instead:", err);
    globalThis.location.href = url;
  });
  return true;
}

/**
 * Install the delegated handler that routes every rendered link, and return a
 * disposer for it.
 *
 * Capture phase, so it decides before SvelteKit's bubble-phase anchor handlers
 * and before the opener plugin's injected click script. That script skips any
 * event already marked `defaultPrevented`, so a routed click has exactly one
 * owner and the opener is called once.
 */
export function installExternalLinkHandler(): () => void {
  if (!shellOpener()) return () => {};

  const internalOrigins = internalOriginsFor(
    CONFIG.appserverDid,
    window.location.origin,
  );

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;

    const anchor = anchorFromEvent(event);
    if (!anchor) return;

    const action = routeLinkClick({
      href: anchor.href,
      download: anchor.hasAttribute("download"),
      modifierClick:
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey,
      isShell: true,
      documentOrigin: window.location.origin,
      documentUrl: window.location.href,
      internalOrigins,
    });

    if (action.kind === "internal") {
      event.preventDefault();
      void goto(action.path);
      return;
    }
    if (action.kind === "external" && openExternal(action.url)) {
      event.preventDefault();
    }
  };

  window.addEventListener("click", onClick, true);
  return () => window.removeEventListener("click", onClick, true);
}

/**
 * The anchor a click landed on, walking the composed path so a click on a
 * child `<span>`/`<img>` inside the anchor still resolves to it, and so a
 * click inside a shadow root or a popover still works.
 */
function anchorFromEvent(event: MouseEvent): HTMLAnchorElement | null {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node;
  }
  // `composedPath` is empty only for synthetic events built without a target;
  // fall back to the event target's ancestor chain.
  const target = event.target;
  return target instanceof Element ? target.closest("a") : null;
}
