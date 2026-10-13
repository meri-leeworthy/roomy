/**
 * The address a Web Tile answers to, and whether a string is one.
 *
 * A tile is an `ing.dasl.masl` record on a PDS, so the only address it has is
 * that record's AT-URI: `at://<repo>/ing.dasl.masl/<rkey>`. `ATTileLoader`
 * (`@dasl/tile-loader/at`) reads the manifest from that record and every
 * resource from the same PDS. For any other shape it declines to load, so a
 * caller that recognises a tile address can name the reason a string did not
 * load instead of passing the loader's blanket failure on to the user.
 *
 * Only `did:plc:` repositories are accepted: the loader's DID→PDS step is a
 * `plc.directory` lookup with no arm for `did:web`.
 *
 * Pure — no DOM, no build env, no imports — so it runs under the package's
 * `node --test` runner.
 */

/** A parsed tile address. */
export interface TileAddress {
  /** The repo holding the manifest record. */
  did: string;
  /** The manifest record's key within `ing.dasl.masl`. */
  rkey: string;
}

/** The collection a tile manifest is published under. */
export const TILE_COLLECTION = "ing.dasl.masl";

/** `did:plc:` followed by the base32 body the method uses. */
const PLC_DID = /^did:plc:[a-z2-7]+$/;

/**
 * ATProto record key, which is one or more of `[A-Za-z0-9._:~-]`. The rkeys a
 * loader sees in practice are TIDs.
 */
const RKEY = /^[A-Za-z0-9._~:-]+$/;

/**
 * Parse a tile AT-URI, or `null` if the string is not one.
 *
 * The shape is exact — scheme, a `did:plc:` authority, three path segments with
 * `ing.dasl.masl` as the collection — and a query or fragment makes it not a
 * record address, so it is rejected rather than stripped.
 */
export function parseTileAddress(uri: string): TileAddress | null {
  if (!uri.startsWith("at://")) return null;
  const rest = uri.slice("at://".length);
  if (rest.includes("?") || rest.includes("#")) return null;

  const segments = rest.split("/");
  if (segments.length !== 3) return null;
  const [did, collection, rkey] = segments;
  if (did === undefined || !PLC_DID.test(did)) return null;
  if (collection !== TILE_COLLECTION) return null;
  if (rkey === undefined || !RKEY.test(rkey)) return null;

  return { did, rkey };
}
