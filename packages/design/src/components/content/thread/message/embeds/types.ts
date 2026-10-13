import type { schemas } from "@roomy-space/sdk";

/** The display fields a link badge renders for a space. */
export type SpaceSummary = typeof schemas.queries.getSpaceSummary.Response.infer;

/** The display fields a link badge renders for a room. */
export type RoomSummary = typeof schemas.queries.getRoomSummary.Response.infer;

/**
 * Looks up a space's display fields for an internal link.
 *
 * The client owns the lookup, so it also owns the request policy: caching,
 * error semantics, and how many times a permanently-failing key may be asked.
 * A resolver that cannot answer — no materialised row, no permission, no
 * session — resolves `undefined` rather than rejecting, which is the state
 * the badge renders its fallback in.
 */
export type SpaceSummaryResolver = (
  spaceId: string,
) => Promise<SpaceSummary | undefined>;

/** Looks up a room's display fields for an internal link. */
export type RoomSummaryResolver = (
  roomId: string,
) => Promise<RoomSummary | undefined>;
