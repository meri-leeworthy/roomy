/**
 * The change feed as current records: a fold over `record_changes`.
 *
 * `docs/plans/record-migration.md` §4 P1. The feed
 * (`streams/recordChanges.ts`) is a log of ops — creates, patches and deletes
 * keyed by `(repo, collection, rkey)` — and this is the one place that turns it
 * into the set of records those ops describe. Pure: no DB, no clock, no I/O, so
 * the Rust worker and the read endpoint fold the same rows the same way rather
 * than each re-deriving the rules.
 *
 * Three rules, and the feed's own shape supplies the rest:
 *
 *  - **`update` on an absent key creates.** Six kinds never emit `create`
 *    (`spaceInfo`, `spaceSidebar`, `roomPermission`, `federationGrant`,
 *    `profile`, `calendarLink` — the adapter is stateless and sees one entry),
 *    and `membership` can update without one. A patch applied to nothing is the
 *    record, so the fold does what the projection rules do: upsert.
 *  - **A patch merges shallowly.** The patch's fields replace the record's at
 *    the top level and nothing recurses: `extensions: null` is a value (the
 *    message kind reads it as "remove all attachments"), not a merge
 *    instruction, and `content` replaces the content it patches.
 *  - **A record's repo is resolved, not stored.** The feed's `repo` for an
 *    `update`/`delete` is the space (the adapter cannot know whose record it
 *    touches). The row carries `actor`, so "the actor's repo holds this record,
 *    therefore this is the author editing their own record — apply there" is
 *    derivable, and that is what makes an edit land beside its create. The
 *    row's repo is kept on the output as `storedRepo` when the two differ.
 *
 * Bodies stay the JSON the feed stores: a `{"$bytes": "<base64>"}` marker is
 * passed through untouched (plan §3 D3), so the fold neither inflates blobs nor
 * invents a shape the row did not carry.
 */

import type { RecordChangeRow } from "../../streams/recordChanges.ts";

/** One record the feed currently describes. */
export interface FoldedRecord {
  /** The repo the record belongs to after repo resolution. */
  readonly repo: string;
  /**
   * The repo the feed stored the last change under, present only when repo
   * resolution moved the record — a space-repo edit of an author's record.
   */
  readonly storedRepo?: string;
  readonly collection: string;
  readonly rkey: string;
  /** The folded body, with the feed's `$bytes` markers intact. */
  readonly record: Readonly<Record<string, unknown>>;
  /** The ordering stamp of the last change applied to this record. */
  readonly orderStamp: string;
  /** How many changes produced this record, at least one. */
  readonly ops: number;
}

/**
 * The body a row carries, or an error naming the row that does not.
 *
 * Kept as a function rather than inlined because a malformed body has to name
 * the row it came from, and the message is only worth writing once.
 */
function bodyOf(row: RecordChangeRow): Readonly<Record<string, unknown>> {
  if (row.body === null) {
    throw new Error(
      `record change: ${row.op} row ${row.collection}/${row.rkey} carries no body`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch (err) {
    throw new Error(
      `record change: ${row.collection}/${row.rkey} body is not JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `record change: ${row.collection}/${row.rkey} body is not a record`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Fold a stream's changes into the records they currently describe.
 *
 * Rows are applied in the order given — the caller reads them in `(idx, ord)`
 * order, which is the log's own — so a key touched twice ends at the last
 * change's body and stamp. The result is ordered by repo, then collection, then
 * rkey, and holds one record per `(repo, collection, rkey)`.
 *
 * Scope is the caller's (plan §3 D2): the feed is partitioned by `stream_id`, so
 * whatever rows are handed over are the whole of the fold's world.
 */
export function foldChanges(
  rows: Iterable<RecordChangeRow>,
): FoldedRecord[] {
  const records = new Map<string, FoldedRecord>();

  for (const row of rows) {
    // Repo resolution: an update or delete lands on the record it touches when
    // the row's actor owns that record, and at the row's own repo otherwise.
    // A create states its repo, so there is nothing to resolve. NUL cannot occur
    // in a DID, an NSID or a record key, so the key is unambiguous.
    const actorHolds =
      row.op !== "create" &&
      records.has(
        `${row.actor}\u0000${row.collection}\u0000${row.rkey}`,
      );
    const repo = actorHolds ? row.actor : row.repo;
    const key = `${repo}\u0000${row.collection}\u0000${row.rkey}`;
    const current = records.get(key);
    const storedRepo = repo === row.repo ? undefined : row.repo;

    if (row.op === "delete") {
      // A delete removes; it never creates, even when nothing is there.
      records.delete(key);
      continue;
    }

    const body = bodyOf(row);
    const record =
      row.op === "update" && current !== undefined
        ? { ...current.record, ...body }
        : body;

    records.set(key, {
      repo,
      ...(storedRepo === undefined ? {} : { storedRepo }),
      collection: row.collection,
      rkey: row.rkey,
      record,
      orderStamp: row.orderStamp,
      ops: (current?.ops ?? 0) + 1,
    });
  }

  return [...records.values()].sort(
    (a, b) =>
      (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) ||
      (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0) ||
      (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0),
  );
}
