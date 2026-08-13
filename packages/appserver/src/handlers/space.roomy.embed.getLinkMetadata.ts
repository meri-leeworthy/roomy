/**
 * XRPC: space.roomy.embed.getLinkMetadata (query).
 *
 * Enriches a URL with link metadata (OpenGraph + oEmbed discovery) so the
 * client can render a rich link preview. This is the appserver-side
 * replacement for the client calling an external embed service directly —
 * enrichment logic now lives in the appserver, is authenticated, and is the
 * seam where ATProto-native enrichment (DID resolution, HappyView, PDS
 * fetches) will later be layered in.
 *
 * Best-effort: a URL that can't be fetched (bot-blocked, offline, non-http)
 * or has no metadata returns an empty object — never an error — so link
 * cards degrade gracefully to a URL-only preview.
 */

import { fetchLinkMetadata } from "../embed/metadata.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { LinkEmbedMetadata } from "../embed/metadata.ts";

export const getLinkMetadataHandler: QueryHandler<
  QueryParams,
  LinkEmbedMetadata
> = async (params: QueryParams) => {
  const url = requireString(params, "url");

  const result = await fetchLinkMetadata(url);
  if (!result) return {};

  // Remove null/undefined so the response matches the optional-field lexicon.
  return stripNulls(result as unknown as Record<string, unknown>) as LinkEmbedMetadata;
};
