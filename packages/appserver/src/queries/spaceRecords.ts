/**
 * A space's change feed as current records, folded once per snapshot.
 *
 * `docs/plans/record-migration.md` §4 P3. The admin read endpoints
 * (`space.roomy.admin.getSpaceRecords`, `space.roomy.admin.getSpaceRecordCounts`)
 * both need the same thing: every record the space's `record_changes`
 * partition currently describes, in lexicon shape. Folding that costs one
 * ordered scan of the partition, so it is computed here once and kept in an
 * in-process LRU keyed by `(space, latest_event)` — the plan's design, and the
 * reason neither endpoint needs a materialised table.
 *
 * The snapshot is the fold's input bound: `stream_state.latest_event` is the
 * partition's highest `idx`, and `idx` is assigned as `max(idx) + 1` and never
 * deleted, so `idx <= snapshot` is exactly the change set at that instant.
 * Pinning it is what makes pagination stable while the space is written to: a
 * cursor carries the snapshot it was minted under, and replaying it folds the
 * same rows even after an append has moved `latest_event` on.
 *
 * Nothing here opens a per-space DB. The feed is partitioned by `stream_id` in
 * the event-log DB, so the events worker answers both the fold's input and the
 * snapshot lookup.
 */

import { openEventsDb } from "../db/db.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { foldChanges } from "../materialization/records/foldChanges.ts";
import {
  KIND_BY_COLLECTION,
  RECORD_KINDS,
  type RecordKind,
} from "../materialization/records/recordKinds.ts";
import { toRecordJson } from "../materialization/records/toRecordJson.ts";
import type { RecordChangeRow } from "../streams/recordChanges.ts";

/** One record the space's feed currently describes, ready to serve. */
export interface SpaceRecord {
  readonly repo: string;
  readonly collection: string;
  readonly rkey: string;
  /** The record as its lexicon declares it, `$type` and `createdAt` included. */
  readonly record: Readonly<Record<string, unknown>>;
  /**
   * Whether the record exists as one change wrote it (`create`) or has been
   * rewritten since (`update`).
   *
   * A fold has no op of its own — an edit of an absent record is an upsert
   * create and a create followed by an edit is two changes. This is the fold's
   * own answer: one applied change means the record is what that change wrote,
   * more than one means it has been rewritten.
   */
  readonly op: "create" | "update";
}

/** How many folded records one kind holds. */
export interface KindCount {
  readonly kind: string;
  readonly collection: string;
  readonly count: number;
}

/** How many folded records one repo holds. */
export interface RepoCount {
  readonly repo: string;
  readonly count: number;
}

/**
 * Folded records a lexicon cannot state, grouped by why.
 *
 * `toRecordJson` reports these rather than bending them into a shape that
 * validates (plan §3 D5): a `federationGrant` patch that is not the record's
 * grant set, and a profile whose fields have no place in
 * `space.roomy.user.profile`. They are counted, not served as records, so the
 * answer to "what would migration lose" is a number rather than a silent drop.
 */
export interface UnexpressibleCount {
  readonly collection: string;
  readonly reason: string;
  readonly count: number;
}

/** Every record a space's feed describes at one snapshot, with its tallies. */
export interface SpaceRecordSet {
  readonly space: string;
  /** The `latest_event` the fold is pinned to. */
  readonly snapshot: number;
  /** Expressible records, ordered by repo, collection, then rkey. */
  readonly records: readonly SpaceRecord[];
  readonly byKind: readonly KindCount[];
  readonly byRepo: readonly RepoCount[];
  readonly unexpressible: {
    readonly total: number;
    readonly entries: readonly UnexpressibleCount[];
  };
}

/** Where a page stopped, and the snapshot it was folded under. */
export interface RecordCursor {
  readonly snapshot: number;
  readonly repo: string;
  readonly collection: string;
  readonly rkey: string;
}

/** Folds kept in memory. An admin surface has few spaces in flight at once. */
const MAX_FOLDS = 8;

/**
 * Cached folds, oldest first. Values are promises so two requests that arrive
 * before the first fold finishes share it; a rejection evicts its entry.
 */
const folds = new Map<string, Promise<SpaceRecordSet>>();

/** Drop every cached fold. Used by tests, which reuse a space DID per DB. */
export function _resetSpaceRecordFolds(): void {
  folds.clear();
}

/** The snapshot a fresh read folds, or `-1` when the stream has no events. */
async function latestEventOf(space: string): Promise<number> {
  const row = await openEventsDb()
    .query("select latest_event from stream_state where stream_id = ?")
    .get<{ latest_event: number }>(space);
  return row?.latest_event ?? -1;
}

/** A `record_changes` row as the fold reads it. */
interface RawRow {
  readonly idx: number;
  readonly ord: number;
  readonly kind: string;
  readonly repo: string;
  readonly collection: string;
  readonly rkey: string;
  readonly op: "create" | "update" | "delete";
  readonly order_stamp: string;
  readonly actor: string;
  readonly event_id: string;
  readonly body: string | null;
}

/**
 * Every change in the space's partition up to `snapshot`, in the log's order.
 *
 * One statement, ordered by the primary key's own `(idx, ord)`, so SQLite walks
 * the partition once and the fold sees the order it applies changes in.
 */
async function changesUpTo(
  space: string,
  snapshot: number,
): Promise<RecordChangeRow[]> {
  const rows = await openEventsDb()
    .query(
      `select idx, ord, kind, repo, collection, rkey, op, order_stamp, actor,
              event_id, body
         from record_changes
        where stream_id = ? and idx <= ?
        order by idx, ord`,
    )
    .all<RawRow>([space, snapshot]);

  return rows.map((row) => ({
    streamId: space,
    idx: row.idx,
    ord: row.ord,
    kind: row.kind,
    repo: row.repo,
    collection: row.collection,
    rkey: row.rkey,
    op: row.op,
    orderStamp: row.order_stamp,
    actor: row.actor,
    eventId: row.event_id,
    body: row.body,
  }));
}

/** Count entries of a map into a list, largest first, ties by key. */
function tally<K extends string>(
  counts: Map<K, number>,
): Array<{ key: K; count: number }> {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) =>
      a.count !== b.count ? b.count - a.count : a.key < b.key ? -1 : 1,
    );
}

/** Fold rows into the set the endpoints serve. */
function foldRows(
  space: string,
  snapshot: number,
  rows: readonly RecordChangeRow[],
): SpaceRecordSet {
  const records: SpaceRecord[] = [];
  const byKind = new Map<RecordKind, number>();
  const byRepo = new Map<string, number>();
  const unexpressible = new Map<string, number>();

  for (const folded of foldChanges(rows)) {
    const json = toRecordJson(folded);
    if (!json.ok) {
      const key = `${folded.collection}\u0000${json.reason}`;
      unexpressible.set(key, (unexpressible.get(key) ?? 0) + 1);
      continue;
    }

    const kind = KIND_BY_COLLECTION[folded.collection];
    if (kind === undefined) {
      throw new Error(
        `record ${folded.collection}/${folded.rkey} names no record kind`,
      );
    }

    records.push({
      repo: folded.repo,
      collection: folded.collection,
      rkey: folded.rkey,
      record: json.record,
      op: folded.ops === 1 ? "create" : "update",
    });
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    byRepo.set(folded.repo, (byRepo.get(folded.repo) ?? 0) + 1);
  }

  return {
    space,
    snapshot,
    records,
    byKind: tally(byKind).map(({ key, count }) => ({
      kind: key,
      collection: RECORD_KINDS[key].collection,
      count,
    })),
    byRepo: tally(byRepo).map(({ key, count }) => ({ repo: key, count })),
    unexpressible: {
      total: [...unexpressible.values()].reduce((sum, n) => sum + n, 0),
      entries: tally(unexpressible).map(({ key, count }) => {
        const [collection, reason] = key.split("\u0000");
        return { collection: collection!, reason: reason!, count };
      }),
    },
  };
}

/**
 * The space's records at `snapshot`, folding at most once per snapshot.
 *
 * `snapshot` defaults to the stream's current `latest_event`; a cursor passes
 * the snapshot it was minted under so a page continuation sees the same fold.
 */
export function loadSpaceRecordSet(
  space: string,
  snapshot?: number,
): Promise<SpaceRecordSet> {
  return (async () => {
    const at = snapshot ?? (await latestEventOf(space));
    // NUL cannot occur in a DID or in an integer, so the key is unambiguous.
    const key = `${space}\u0000${at}`;

    const cached = folds.get(key);
    if (cached !== undefined) {
      // Refresh recency: Map iteration order is insertion order.
      folds.delete(key);
      folds.set(key, cached);
      return cached;
    }

    const pending = (async () => {
      const rows = at < 0 ? [] : await changesUpTo(space, at);
      return foldRows(space, at, rows);
    })();

    folds.set(key, pending);
    if (folds.size > MAX_FOLDS) {
      const oldest = folds.keys().next();
      if (!oldest.done) folds.delete(oldest.value);
    }

    try {
      return await pending;
    } catch (err) {
      if (folds.get(key) === pending) folds.delete(key);
      throw err;
    }
  })();
}

/** Whether a record sorts after the cursor's position. */
export function isAfterCursor(
  record: Pick<SpaceRecord, "repo" | "collection" | "rkey">,
  cursor: RecordCursor,
): boolean {
  if (record.repo !== cursor.repo) return record.repo > cursor.repo;
  if (record.collection !== cursor.collection) {
    return record.collection > cursor.collection;
  }
  return record.rkey > cursor.rkey;
}

/** A cursor as the opaque string the endpoints hand back. */
export function encodeRecordCursor(cursor: RecordCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * The cursor an opaque string names, or a 400 naming the problem.
 *
 * The value is opaque to callers but not secret; a malformed one is a client
 * error rather than a silent restart at the first page, which would loop a
 * pager forever.
 */
export function decodeRecordCursor(raw: string): RecordCursor {
  const invalid = (why: string): XrpcError =>
    new XrpcError(
      400,
      "InvalidRequest",
      `cursor is not one this endpoint issued: ${why}`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid("not base64url JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("not an object");
  }

  const { snapshot, repo, collection, rkey } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof snapshot !== "number" ||
    !Number.isInteger(snapshot) ||
    typeof repo !== "string" ||
    typeof collection !== "string" ||
    typeof rkey !== "string"
  ) {
    throw invalid("missing its snapshot or position");
  }
  return { snapshot, repo, collection, rkey };
}
