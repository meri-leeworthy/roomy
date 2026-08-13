/**
 * Client-side link-embed enrichment.
 *
 * The composer reaches out to the embed service directly (the same
 * Lantern-chat embed-service the appserver's sweeper uses) so a link preview
 * can be shown below the chat input *before* the message is sent — no round
 * trip through the appserver's enrichment backlog.
 *
 * The embed service accepts a URL via POST and returns a 2-element JSON
 * array: `[timestamp, EmbedV1]`. We surface the EmbedV1 payload as the SDK's
 * `LinkEmbedData` shape (a structural subset) so it can be rendered by the
 * existing `LinkCard` component.
 */

import { env as dynamicEnv } from "$env/dynamic/public";
import type { schemas } from "@roomy-space/sdk";

type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

/**
 * Public embed-service origin. The appserver's default
 * (`https://embed.internal.weird.one`) is internal-only, so production must
 * set `PUBLIC_EMBED_SERVICE_URL` to a publicly reachable origin. Falls back
 * to the internal default for local dev where the browser can reach it.
 */
const EMBED_SERVICE_URL =
  dynamicEnv.PUBLIC_EMBED_SERVICE_URL || "https://embed.internal.weird.one";

/** Hard timeout for a single embed-service request. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Regex to detect URLs in plain-text content (the legacy markdown path).
 * Matches common URL patterns including protocol-relative and wrapped in
 * angle brackets. Skips trailing punctuation that's not part of the URL.
 */
const URL_REGEX =
  /<?(https?:\/\/)[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s<>]*[a-zA-Z0-9\/]>?/gi;

/**
 * Extract unique, valid HTTP(S) URLs from a string of text.
 * Strips surrounding angle brackets and trailing punctuation.
 */
export function extractUrls(text: string): string[] {
  const matches = text.matchAll(URL_REGEX);
  const urls = new Set<string>();
  for (const match of matches) {
    let url = match[0];
    if (url.startsWith("<") && url.endsWith(">")) {
      url = url.slice(1, -1);
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urls.add(url);
  }
  return [...urls];
}

/**
 * Fetch embed metadata for a single URL from the embed service.
 *
 * Best-effort: returns `null` on any failure (timeout, non-OK status, or a
 * 200 with an empty payload) so the composer can degrade gracefully to a
 * URL-only preview. Never throws.
 */
export async function fetchEmbedData(
  url: string,
): Promise<LinkEmbedData | null> {
  const locale =
    typeof navigator !== "undefined"
      ? navigator.languages?.[0] || navigator.language || "en"
      : "en";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${EMBED_SERVICE_URL}?lang=${locale}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: url,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as [string, LinkEmbedData];
    return data[1] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
