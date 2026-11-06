/**
 * Arktype schema for `space.roomy.admin.getSpaceRecordCounts`.
 *
 * Counts a space's folded records per kind and per repo for the record
 * browser's tree, plus the folded records no lexicon can state — the tally
 * a migration format has to answer for. Admin-only.
 */
import { type } from "arktype";

export const NSID = "space.roomy.admin.getSpaceRecordCounts" as const;

export const Params = type({
  space: "string",
});

export const KindCount = type({
  kind: "string",
  collection: "string",
  count: "number",
});

export const RepoCount = type({
  repo: "string",
  count: "number",
});

export const UnexpressibleCount = type({
  collection: "string",
  reason: "string",
  count: "number",
});

export const Response = type({
  space: "string",
  /** The stream's `latest_event` these counts describe. */
  snapshot: "number",
  /** Expressible records: the sum of `byKind` and of `byRepo`. */
  total: "number",
  byKind: KindCount.array(),
  byRepo: RepoCount.array(),
  unexpressible: type({
    total: "number",
    entries: UnexpressibleCount.array(),
  }),
});
