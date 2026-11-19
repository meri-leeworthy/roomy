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
 * Four rules, and the feed's own shape supplies the rest:
 *
 *  - **`update` on an absent key creates.** Seven kinds never emit `create`
 *    (`spaceInfo`, `spaceSidebar`, `roomPermission`, `federationGrant`,
 *    `federationReceiverGrant`, `profile`, `calendarLink` — the adapter is
 *    stateless and sees one entry), and `membership` can update without one. A
 *    patch applied to nothing is the record, so the fold does what the
 *    projection rules do: upsert.
 *  - **A patch merges shallowly.** The patch's fields replace the record's at
 *    the top level and nothing recurses: `extensions: null` is a value (the
 *    message kind reads it as "remove all attachments"), not a merge
 *    instruction, and `content` replaces the content it patches.
 *  - **A grant patch changes one entry.** The two federation grant kinds are
 *    sets, not fields: `setRoomPermission` names one room and
 *    `setReceiverPermission` one (room, grantee, granteeKind), so a shallow
 *    merge would make the second setter replace the first instead of adding to
 *    it. Their patches upsert or remove an entry of the record's array, keyed
 *    as {@link ENTRY_PATCHED} says, and a `null` permission removes it. This is
 *    the rule the projection already encodes in `federation_room_permissions`
 *    and `federation_receiver_permissions` — a port, not a new judgement.
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
import { RECORD_KINDS } from "./recordKinds.ts";

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
 * A kind whose patch changes one entry of an array in the record rather than a
 * top-level field, and what identifies that entry.
 *
 * `keyField` is the record's field the rkey states, synthesised when the fold
 * begins at a patch: the same derivation `toRecordJson` makes for a membership
 * whose first change is an admin grant.
 */
interface EntryPatch {
  /** The record field holding the entries. */
  readonly field: string;
  /** The patch fields that key one entry. */
  readonly key: readonly string[];
  /** The record field the record's rkey is the value of. */
  readonly keyField: string;
}

const ENTRY_PATCHED: Readonly<Record<string, EntryPatch>> = {
  [RECORD_KINDS.federationGrant.collection]: {
    field: "origin",
    key: ["room"],
    keyField: "federatingSpace",
  },
  [RECORD_KINDS.federationReceiverGrant.collection]: {
    field: "receiver",
    key: ["room", "grantee", "granteeKind"],
    keyField: "originSpace",
  },
};

/** The entry key the given field values name, unambiguous for the same reason the record key is. */
function entryKey(
  values: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | undefined {
  const parts: string[] = [];
  for (const field of fields) {
    const value = values[field];
    if (typeof value !== "string") return undefined;
    parts.push(value);
  }
  return parts.join("\u0000");
}

/**
 * Apply one grant patch: upsert the entry it names, or remove that entry when
 * the permission is `null`.
 *
 * Entries keep their order — a replaced entry stays where it was — so a fold of
 * the same rows always produces the same body.
 */
function applyEntryPatch(
  base: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  rule: EntryPatch,
): Readonly<Record<string, unknown>> {
  const held = base[rule.field];
  const entries: Readonly<Record<string, unknown>>[] = Array.isArray(held)
    ? [...(held as Readonly<Record<string, unknown>>[])]
    : [];
  const key = entryKey(patch, rule.key);

  if (key !== undefined) {
    const at = entries.findIndex(
      (entry) => entryKey(entry, rule.key) === key,
    );
    if (patch["permission"] === null) {
      if (at !== -1) entries.splice(at, 1);
    } else if (at === -1) {
      entries.push(patch);
    } else {
      entries[at] = { ...entries[at], ...patch };
    }
  }

  return { ...base, [rule.field]: entries };
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
    const entryRule = ENTRY_PATCHED[row.collection];
    let record: Readonly<Record<string, unknown>>;
    if (row.op !== "update") {
      record = body;
    } else if (entryRule === undefined) {
      record =
        current !== undefined ? { ...current.record, ...body } : body;
    } else {
      // A grant patch names one entry, so the record it applies to is an empty
      // set when the fold starts at the patch — and it still knows which space
      // it is about, because the rkey says so.
      const base =
        current?.record ?? {
          [entryRule.keyField]: row.rkey,
          [entryRule.field]: [],
        };
      record = applyEntryPatch(base, body, entryRule);
    }

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
