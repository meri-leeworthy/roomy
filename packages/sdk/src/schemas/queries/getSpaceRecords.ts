/**
 * Arktype schema for `space.roomy.admin.getSpaceRecords`.
 *
 * Pages a space's change feed folded to the records it currently describes.
 * Admin-only. The cursor is opaque and pins the snapshot, so a continuation
 * returns the same records even after the space is written to.
 */
import { type } from "arktype";

export const NSID = "space.roomy.admin.getSpaceRecords" as const;

export const Params = type({
  space: "string",
  /** Only records whose folded repo is this DID. */
  "repo?": "string",
  /** Only records of this collection. */
  "collection?": "string",
  /** The previous page's cursor; replay with the same filters. */
  "cursor?": "string",
  "limit?": "string",
});

export const SpaceRecord = type({
  repo: "string",
  collection: "string",
  rkey: "string",
  /** The lexicon record: `$type`, `createdAt`, and the kind's fields. */
  record: "object",
  /** One change produced the record, or it has been rewritten since. */
  op: "'create' | 'update'",
});

export const Response = type({
  records: SpaceRecord.array(),
  /** Present when more records follow; absent on the last page. */
  "cursor?": "string",
});
