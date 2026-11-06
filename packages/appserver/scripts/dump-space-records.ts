/**
 * Print one space's current records as JSONL — the folded change feed.
 *
 * `docs/plans/record-migration.md` §4 P1's view of "what would this space look
 * like as records": one line per record, `{repo, collection, rkey, record}`,
 * ordered by repo, then collection, then rkey. Nothing is written and nothing
 * outside the events DB is opened — the feed's rows are the whole input
 * (`src/materialization/records/foldChanges.ts`), so the answer is the same one
 * the read endpoint will give.
 *
 * Usage:
 *   bun run scripts/dump-space-records.ts --space <did> [--data-dir <dir>]
 *                                        [--events <path>] [--repo <did>]
 *                                        [--collection <nsid>]
 *
 * `--space` is required: the feed is partitioned by `stream_id`, so a dump
 * without one has no scope to fold. The DB is opened read-only, so this can run
 * beside a live appserver — unlike the backfill, it has nothing to write.
 */

import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  foldChanges,
  type FoldedRecord,
} from "../src/materialization/records/foldChanges.ts";
import type { RecordChangeRow } from "../src/streams/recordChanges.ts";

/** What one run was asked for. */
export interface DumpArgs {
  readonly eventsPath: string;
  readonly space: string;
  readonly repo?: string;
  readonly collection?: string;
}

const FLAGS = ["--data-dir", "--events", "--space", "--repo", "--collection"];

/**
 * Parse the flags into the paths and filters a dump needs, or name the first
 * thing wrong with them. A value may follow its flag or be attached with `=`;
 * an unknown flag or a missing value is an error rather than a guess.
 */
export function parseDumpArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: DumpArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!FLAGS.includes(name)) {
      return { ok: false, error: `unknown flag: ${name}` };
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") {
      return { ok: false, error: `${name} needs a value` };
    }
    values.set(name, value);
  }

  const space = values.get("--space");
  if (space === undefined) return { ok: false, error: "--space is required" };

  const dataDir = values.get("--data-dir") ?? env.DATA_DIR ?? "data";
  const repo = values.get("--repo");
  const collection = values.get("--collection");
  return {
    ok: true,
    value: {
      eventsPath: values.get("--events") ?? join(dataDir, "roomy-events.sqlite"),
      space,
      ...(repo === undefined ? {} : { repo }),
      ...(collection === undefined ? {} : { collection }),
    },
  };
}

/**
 * Every change the feed holds for one stream, in `(idx, ord)` order.
 *
 * Iterated rather than collected: a fold needs all of a stream's rows but never
 * all of them at once, and a large space's feed is the biggest thing this script
 * touches. The columns are the row shape `streams/recordChanges.ts` reads.
 */
function* spaceChanges(
  db: Database,
  space: string,
): Generator<RecordChangeRow> {
  const rows = db
    .prepare<
      {
        idx: number;
        ord: number;
        kind: string;
        repo: string;
        collection: string;
        rkey: string;
        op: "create" | "update" | "delete";
        order_stamp: string;
        actor: string;
        event_id: string;
        body: string | null;
      },
      [string]
    >(
      `select idx, ord, kind, repo, collection, rkey, op, order_stamp, actor,
              event_id, body
         from record_changes
        where stream_id = ?
        order by idx, ord`,
    )
    .iterate(space);

  for (const row of rows) {
    yield {
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
    };
  }
}

/**
 * Fold one space's feed and apply the optional repo and collection filters.
 *
 * The filters narrow what is printed, never what is folded: a repo filter that
 * also cut the fold's input would change which records exist, and a record
 * re-homed by an edit has a stored repo the caller may be filtering on.
 */
export function readSpaceRecords(
  db: Database,
  args: Pick<DumpArgs, "space" | "repo" | "collection">,
): FoldedRecord[] {
  const records = foldChanges(spaceChanges(db, args.space));
  return records.filter(
    (record) =>
      (args.repo === undefined || record.repo === args.repo) &&
      (args.collection === undefined ||
        record.collection === args.collection),
  );
}

/** The line a dump prints for one record: its identity and its folded body. */
export function recordLine(record: FoldedRecord): string {
  return JSON.stringify({
    repo: record.repo,
    collection: record.collection,
    rkey: record.rkey,
    record: record.record,
  });
}

function main(): number {
  const parsed = parseDumpArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`dump-space-records: ${parsed.error}\n`);
    return 2;
  }
  const { eventsPath, space } = parsed.value;

  let db: Database;
  try {
    db = new Database(eventsPath, { readonly: true });
  } catch (err) {
    process.stderr.write(
      `dump-space-records: cannot open ${eventsPath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 2;
  }

  try {
    let count = 0;
    for (const record of readSpaceRecords(db, parsed.value)) {
      process.stdout.write(`${recordLine(record)}\n`);
      count++;
    }
    process.stderr.write(
      `dump-space-records: ${count} records for ${space}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = main();
}
