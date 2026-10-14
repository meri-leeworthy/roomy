/**
 * Anonymous XRPC reads for server loads — the read path behind a
 * server-rendered `<head>`.
 *
 * The module sits under `$lib/server` so the bundler, not convention, keeps it
 * out of the client bundle: SvelteKit refuses to import a `$lib/server` module
 * from client code.
 *
 * Two rules it carries:
 *
 * - **No caller credentials, ever.** The reads are `fetch`es with no
 *   `Authorization` and no cookies, using the global `fetch` rather than the
 *   load's `event.fetch` — so there is no per-request header bag to inherit
 *   from. The response is therefore safe to hand to anyone, which is what lets
 *   the document it renders be cached publicly downstream.
 * - **`null`, not a throw.** A space that does not exist, a room in an
 *   invite-only space, a rate limit and a network failure are one outcome for
 *   the head: fall back to the site defaults and serve the document anyway.
 *   The document must be served in every case.
 */

import { env } from "$env/dynamic/private";
import { transport } from "@roomy-space/sdk";
import { CONFIG } from "$lib/config";

const { resolveAppserverHttpOrigin } = transport;

/**
 * How long an anonymous read may take before the head gives up on it. A
 * degraded head costs a link preview; a head that waits on an unresponsive
 * appserver costs the document, so the read is bounded well below any origin's
 * own timeout.
 */
const XRPC_TIMEOUT_MS = 5_000;

/**
 * The appserver origin this process reads from, resolved once.
 *
 * `CONFIG.appserverHttpOrigin` is the local-development override (and the
 * e2e stack's): both are known before any request. In production it is null,
 * and the origin is only discoverable from the appserver's DID document, so
 * that resolution is cached here rather than repeated per request — an SSR
 * origin is one client for every visitor.
 *
 * A resolution failure is not cached, so a transient one does not leave the
 * process without an appserver for its lifetime.
 */
let cachedOrigin: string | null = null;

export async function serverAppserverOrigin(): Promise<string | null> {
  if (cachedOrigin) return cachedOrigin;

  const configured =
    env.APP_SERVER_HTTP_ORIGIN?.trim() || CONFIG.appserverHttpOrigin;
  if (configured) {
    cachedOrigin = configured.replace(/\/+$/, "");
    return cachedOrigin;
  }

  try {
    cachedOrigin = await resolveAppserverHttpOrigin(CONFIG.appserverDid);
    return cachedOrigin;
  } catch {
    return null;
  }
}

/** An anonymous XRPC GET, or `null` for every way it can fail. */
export async function publicXrpc<T>(
  nsid: string,
  params: Record<string, string>,
): Promise<T | null> {
  const origin = await serverAppserverOrigin();
  if (!origin) return null;

  const url = new URL(`/xrpc/${nsid}`, origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(XRPC_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The `space.roomy.space.getMetadata` fields an unfurl of a space reads. */
export interface PublicSpaceMeta {
  name?: string;
  description?: string;
  avatar?: string;
}

/** The `space.roomy.room.getMetadata` fields an unfurl of a room reads. */
export interface PublicRoomMeta {
  name?: string;
}

/** The `space.roomy.user.getProfile` fields an unfurl of a profile reads. */
export interface PublicProfileMeta {
  displayName?: string;
  handle?: string;
  description?: string;
  avatar?: string;
}
