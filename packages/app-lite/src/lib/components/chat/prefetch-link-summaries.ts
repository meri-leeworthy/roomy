/**
 * Per-room prefetch of internal-link badge summaries.
 *
 * The "enrich internal links" feature mounts a {@link SpaceRoomBadge} for every
 * internal link rendered in a message. Each badge reads its
 * `getSpaceSummary` / `getRoomSummary` through a resolver on mount. In a
 * virtualized message list, scrolling recycles rows and re-runs the enrichment
 * action, so without prefetch every badge starts with a cold cache miss and
 * fires an XRPC call — one per link per render. Under normal scroll load this
 * became the appserver CPU/latency spike seen after the "enrich internal
 * links" change.
 *
 * This module hoists that fan-out into a single per-room pass: it scans the
 * room's loaded message markdown for internal links, collects the unique
 * `(spaceId, roomId?)` targets, and warms each summary through the same
 * resolver the badges use. When the badges mount they hit the cache instead
 * of issuing cold fetches. Subsequent scroll-recycles are free.
 *
 * Going through the resolver rather than `ensureQueryData` directly is what
 * keeps the request policy in one place: a key that has already failed is
 * skipped there, so a prefetch pass cannot re-ask a doomed lookup any more
 * than a badge can. A target the appserver has no materialised row for (a
 * stale internal link) therefore costs one request per session, not one per
 * pass.
 *
 * Only the lightweight summary queries are prefetched (not `getMetadata`),
 * matching what {@link SpaceRoomBadge} actually reads.
 */

import { renderMarkdownSanitized } from "@roomy/design/utils";
import { parseInternalLinkHref } from "@roomy-space/sdk";
import { enrichInternalLinksFromBlocks, internalLinkOrigins } from "./enrich-internal-links";
import { resolveRoomSummary, resolveSpaceSummary } from "$lib/queries/badge-summaries";
import type { Block } from "@roomy-space/sdk";

/**
 * Extract the unique internal-link targets from a set of markdown strings.
 *
 * Renders each markdown to the same sanitized HTML the message UI renders
 * (cached, so repeated calls are cheap), then parses out
 * `a[data-roomy-internal-link="true"]` hrefs and runs
 * {@link parseInternalLinkHref} on each. This guarantees parity with the
 * {@link enrichInternalLinks} action: the prefetcher sees exactly the links
 * that will be enriched.
 *
 * `origins` defaults to the runtime's {@link internalLinkOrigins}; passed in
 * so the function stays pure and testable.
 */
export function extractInternalLinkTargets(
  markdowns: Iterable<string>,
  origins: readonly string[] = internalLinkOrigins,
): { spaceId: string; roomId?: string }[] {
  const seen = new Set<string>();
  const targets: { spaceId: string; roomId?: string }[] = [];

  for (const markdown of markdowns) {
    if (!markdown) continue;
    const html = renderMarkdownSanitized(markdown);
    if (!html.includes("data-roomy-internal-link")) continue;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = doc.querySelectorAll<HTMLAnchorElement>(
      'a[data-roomy-internal-link="true"]',
    );
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const target = parseInternalLinkHref(href, origins);
      if (!target) continue;
      // Dedupe by `${spaceId}/${roomId ?? ""}`. Two links to the same room
      // share one cache entry — that's the whole point.
      const dedupeKey = `${target.spaceId}/${target.roomId ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push(target);
    }
  }

  return targets;
}

/**
 * Prefetch the `getSpaceSummary` / `getRoomSummary` queries for every
 * internal link target referenced by the given markdown strings.
 *
 * The promises are intentionally not awaited by callers — the prefetch is
 * best-effort and should not block rendering; badges render with their own
 * loading state (the spaceId/roomId fallback text) until the data lands.
 *
 * Call from a Svelte `$effect` that tracks the loaded message list so the
 * cache is warmed as new messages arrive (e.g. infinite-scroll pages).
 */
export function prefetchInternalLinkSummaries(
  markdowns: Iterable<string>,
  origins: readonly string[] = internalLinkOrigins,
): void {
  if (origins.length === 0) return; // SSR / non-browser — nothing to prefetch.
  const targets = extractInternalLinkTargets(markdowns, origins);
  if (targets.length === 0) return;

  for (const { spaceId, roomId } of targets) {
    // The space lookup is always worth warming: the badge renders the space
    // avatar+name unless this is the current space, which the badge decides
    // at render time.
    void resolveSpaceSummary(spaceId);
    if (roomId) void resolveRoomSummary(roomId);
  }
}

/**
 * Prefetch the `getSpaceSummary` / `getRoomSummary` queries for every
 * internal link target referenced by the given blocks+facets bodies.
 *
 * Reads `#roomRef` facets directly (no markdown render, no DOM walk) via
 * {@link enrichInternalLinksFromBlocks}. Same cache-warming contract as
 * {@link prefetchInternalLinkSummaries}: best-effort, not awaited.
 */
export function prefetchInternalLinkSummariesFromBlocks(
  blocksList: Iterable<Block[]>,
): void {
  const targets: { spaceId: string; roomId?: string }[] = [];
  const seen = new Set<string>();
  for (const blocks of blocksList) {
    for (const target of enrichInternalLinksFromBlocks(blocks)) {
      const dedupeKey = `${target.spaceId}/${target.roomId ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push(target);
    }
  }
  if (targets.length === 0) return;

  for (const { spaceId, roomId } of targets) {
    void resolveSpaceSummary(spaceId);
    if (roomId) void resolveRoomSummary(roomId);
  }
}
