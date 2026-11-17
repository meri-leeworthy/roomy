/**
 * XRPC: space.roomy.space.getDiscoverableSpaces (query).
 *
 * Spaces a reader may be pointed at: public to join (`allow_public_join` unset
 * or 1) and not opted out of being suggested (`suggest_to_others` unset or 1).
 * Backs the homepage's Discover Spaces section, so the list is decided here
 * rather than by a client-side filter: a space whose admins answered "no" can
 * never appear, whatever the client does with the response.
 *
 * ── Cost model ──────────────────────────────────────────────────────────
 *
 * Both settings live in each space's own DB (`comp_space`), so reading them
 * per candidate would open a space DB per space per request — the O(all
 * spaces) fan-out `space.roomy.admin.listSpaces` documents at ~19s for 4276
 * spaces. `space_discovery` (schema-global.sql) carries a copy of both
 * columns in the global DB, written by `applyBatch` when a chunk can change
 * them and reconciled by the boot sweep — so this handler opens no per-space
 * DB at all: one query over `space_discovery` joined to the member-count
 * aggregate for the ordering, bounded by `limit`.
 *
 * Display fields (name, avatar, description) are deliberately NOT returned:
 * they too live per space, and the client already fetches a card's metadata
 * through `space.roomy.space.getMetadata` for the spaces it decides to render.
 *
 * Authorisation: none — the settings it filters on are public space policy,
 * and the response carries nothing per-caller.
 */

import { openGlobalDb } from "../db/db.ts";
import { selectDiscoverableSpaces } from "../queries/spaceDiscovery.ts";
import { optionalInt } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface DiscoverableSpace {
  id: string;
}

export interface GetDiscoverableSpacesResult {
  spaces: DiscoverableSpace[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const getDiscoverableSpacesHandler: QueryHandler<
  QueryParams,
  GetDiscoverableSpacesResult
> = async (params: QueryParams, _auth: AuthCtx) => {
  const limit = optionalInt(params, "limit", {
    min: 1,
    max: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  });

  const dids = await selectDiscoverableSpaces(openGlobalDb(), limit);
  return { spaces: dids.map((id) => ({ id })) };
};
