/**
 * The fold's records as lexicon records.
 *
 * `docs/plans/record-migration.md` §4 P2. `foldChanges` produces the current
 * record set from the change feed, but a fold body is the JSON the feed stores:
 * no `$type`, no `createdAt`, and nulls where a field is unset. This is the one
 * place that turns one into an ATProto record, so a reader validating against
 * `lexicons/` and the read endpoint that serves the records agree on the shape.
 *
 * Four rules, and the lexicons carry the rest:
 *
 *  - **`$type` is the collection.** A record's type is the collection it lives
 *    in; the fold's `collection` column is that, so nothing is looked up.
 *  - **`createdAt` is the ordering stamp's time** (plan §3 D4), the log's
 *    receipt time, which is what the stamp's first ten characters encode. Not a
 *    render-time clock, so two reads of the same record produce the same bytes.
 *  - **Null is unset, and unset is absent.** A lexicon field is either present
 *    with a value or absent; there is no null. The fold's nulls (`parent: null`
 *    for a room with no parent, `extensions: null` from an edit that removed
 *    every attachment) are dropped, which is what they mean.
 *  - **Blob-shaped fields stay as the feed carries them** (plan §3 D3).
 *    Attachment bytes are the feed's `{"$bytes": "<base64>"}` marker — the JSON
 *    encoding of the lexicon's `bytes` type — and avatars stay the reference
 *    strings the projection holds. Nothing is inflated and no blob ref is
 *    invented; uploading a blob is a write-path step.
 *
 * Two kinds do not survive that. `federationGrant`'s body is a *patch* — the
 * adapter never writes the whole record, so every fold of one is
 * `{scope, room, grantee, permission}`, and turning that into the record's
 * `origin`/`receiver` arrays needs the projection's per-entry merge, which is
 * fold semantics and not this file's to guess. The folded `profile` body is a
 * projection row, not the `space.roomy.user.profile` record users write to
 * their PDS: `name`/`description` have fields there, while an `atblob://`
 * avatar and a bridged `handle` do not. Both are reported as unexpressible
 * rather than bent into a shape that validates, and the caller counts them —
 * the "cannot be expressed" list plan §3 D5 asks for.
 */

import { decodeTime } from "ulidx";

import type { FoldedRecord } from "./foldChanges.ts";
import { RECORD_KINDS, type RecordKind } from "./recordKinds.ts";

/** A record as it appears in a repo: the fields, plus its type. */
export interface JsonRecord {
  readonly $type: string;
  readonly [field: string]: unknown;
}

/**
 * The record a folded record describes, or the reason it describes none.
 *
 * Both outcomes are ordinary: a feed holds records a per-repo record model
 * cannot state, and the tally of those is worth more than a shape that lies.
 */
export type RecordJson =
  | { readonly ok: true; readonly record: JsonRecord }
  | { readonly ok: false; readonly reason: string };

/** The kind a collection belongs to — the fold carries the NSID, not the kind. */
const KIND_BY_COLLECTION: Readonly<Record<string, RecordKind>> =
  Object.fromEntries(
    (Object.keys(RECORD_KINDS) as RecordKind[]).map((kind) => [
      RECORD_KINDS[kind].collection,
      kind,
    ]),
  );

/**
 * The profile record's field for each folded profile field, and nothing for the
 * ones it has none for.
 *
 * `space.roomy.user.profile` is the one collection with a deployed lexicon and
 * live records in users' repos — what a user's client writes — so its shape is
 * fixed rather than open to a fold's. The fold's profile body is the
 * projection's `comp_info` row: `name` is the record's `displayName`,
 * `description` is its own field, and an `atblob://` avatar reference and a
 * bridged `handle` have nowhere to go.
 */
const PROFILE_FIELDS: Readonly<Record<string, string>> = {
  name: "displayName",
  description: "description",
};

/**
 * The record a folded record describes, or why it describes none.
 *
 * Throws for a collection no kind declares: the feed is written by the adapter,
 * which only emits known kinds, so an unknown one is a corrupt row and not a
 * record the record model is missing.
 */
export function toRecordJson(folded: FoldedRecord): RecordJson {
  const kind = KIND_BY_COLLECTION[folded.collection];
  if (kind === undefined) {
    throw new Error(
      `record ${folded.collection}/${folded.rkey} names no record kind`,
    );
  }

  switch (kind) {
    case "federationGrant":
      // Every fold of one is a patch: the adapter has no create for this kind,
      // so `origin`/`receiver` were never written. Assembling them means
      // applying the patch's upsert-per-entry rule, which is the fold's job.
      return {
        ok: false,
        reason:
          "the fold carries a single-origin grant patch, not the record's grant set",
      };

    case "profile":
      return profileRecord(folded);

    case "membership":
      // `addAdmin` writes `{can}` alone, and an update to a record that is not
      // there creates it — so a fold that begins at an admin grant has no
      // `user` in its body. The key is the member's DID, so the record still
      // knows whose it is.
      return expressible(folded, {
        ...folded.record,
        user: folded.record.user ?? folded.rkey,
      });

    default:
      // Every other kind's body is its record: the projection rules were
      // written per kind, and the kind's body type is what they write.
      return expressible(folded, folded.record);
  }
}

/** A record is its body, without the fold's nulls and with its type and time. */
function expressible(
  folded: FoldedRecord,
  body: Readonly<Record<string, unknown>>,
): RecordJson {
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) fields[field] = value;
  }
  return {
    ok: true,
    record: { $type: folded.collection, ...fields, createdAt: createdAtOf(folded) },
  };
}

/**
 * The profile record a folded profile body describes, or why it describes none.
 *
 * A folded field the record has no place for makes the whole record
 * unexpressible rather than being dropped: a profile whose avatar vanished
 * between the fold and the record would be a record that lies about what the
 * log says.
 */
function profileRecord(folded: FoldedRecord): RecordJson {
  const unplaceable = Object.entries(folded.record)
    .filter(
      ([field, value]) =>
        PROFILE_FIELDS[field] === undefined && value !== undefined && value !== null,
    )
    .map(([field]) => field);
  if (unplaceable.length > 0) {
    return {
      ok: false,
      reason: `the profile record has no field for ${unplaceable.sort().join(" or ")}`,
    };
  }

  const body: Record<string, unknown> = {};
  for (const [field, target] of Object.entries(PROFILE_FIELDS)) {
    body[target] = folded.record[field];
  }
  return expressible(folded, body);
}

/** The instant the ordering stamp names, as a record's `createdAt`. */
function createdAtOf(folded: FoldedRecord): string {
  try {
    return new Date(decodeTime(folded.orderStamp)).toISOString();
  } catch {
    throw new Error(
      `record ${folded.collection}/${folded.rkey}: order stamp ${folded.orderStamp} carries no time`,
    );
  }
}
