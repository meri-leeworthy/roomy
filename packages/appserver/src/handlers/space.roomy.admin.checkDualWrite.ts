/**
 * XRPC: space.roomy.admin.checkDualWrite (query).
 *
 * Reads the current dual-write state of the Phase-1 per-space DB split and
 * reports whether the derived DBs are consistent with the monolithic DB
 * (source of truth). This is a read-only, remote, authenticated way to
 * evaluate a deployment after rollout or on demand.
 *
 * For each space it compares:
 *   - mono vs per-space: comp_room, comp_content, comp_space, comp_info
 *   - mono vs global: joinedSpace / leftSpace membership edges
 *   - per-space membership edges (must be 0 — membership routes to global)
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 *
 * Query params:
 *   - did      (optional) restrict the deep check to one space.
 *   - verbose  (optional "1") include per-table counts in the response.
 */

import { StreamDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

const STREAM_TABLES = ["comp_room", "comp_content", "comp_space", "comp_info"] as const;
const MEMBERSHIP_LABELS = ["joinedSpace", "leftSpace"] as const;

interface TableCounts {
  comp_room: number;
  comp_content: number;
  comp_space: number;
  comp_info: number;
}

interface MembershipCounts {
  joinedSpace: number;
  leftSpace: number;
}

interface SpaceReport {
  streamDid: string;
  status: "ok" | "diverged";
  diffs: string[];
  counts?: {
    mono: TableCounts & { membership: MembershipCounts };
    perSpace: TableCounts & { membership: MembershipCounts };
    global: MembershipCounts;
  };
}

interface CheckDualWriteResult {
  checked: number;
  diverged: number;
  spaces: SpaceReport[];
}

type AnyDb = {
  query(sql: string): {
    get<Row>(...params: unknown[]): Promise<Row | null>;
  };
};

/**
 * Count a table's rows for one space in the monolithic DB, using the SAME
 * criterion the per-space backfill copies them by (worker.ts backfillSpaceDb),
 * otherwise spaces whose root entity carries a differing stream_id would
 * false-positive as diverged.
 *
 * - comp_space is copied by `entity = spaceDid` (the root's stream_id may
 *   differ from the space DID), so it is counted the same way.
 * - the other stream tables are copied by `entity in (entities where
 *   stream_id = spaceDid) OR entity = spaceDid` — a space's own comp_info /
 *   comp_room rows are included regardless of the root entity's stream_id
 *   (backfillSpaceDb STREAM_OR_SPACE).
 */
async function monoTableCount(
  db: AnyDb,
  spaceDid: string,
  table: (typeof STREAM_TABLES)[number],
): Promise<number> {
  const isSpace = table === "comp_space";
  const where = isSpace
    ? "entity = ?"
    : "entity in (select id from entities where stream_id = ?) or entity = ?";
  const row = await db
    .query(`select count(*) as n from ${table} where ${where}`)
    .get<{ n: number }>(...([spaceDid, ...(isSpace ? [] : [spaceDid])]));
  return row?.n ?? 0;
}

/** Count all rows of a table in the per-space DB (it only holds one stream). */
async function perSpaceTableCount(
  db: AnyDb,
  table: (typeof STREAM_TABLES)[number],
): Promise<number> {
  const row = await db.query(`select count(*) as n from ${table}`).get<{ n: number }>();
  return row?.n ?? 0;
}

async function membershipCount(
  db: AnyDb,
  spaceDid: string,
  label: (typeof MEMBERSHIP_LABELS)[number],
): Promise<number> {
  const row = await db
    .query("select count(*) as n from edges where tail = ? and label = ?")
    .get<{ n: number }>(spaceDid, label);
  return row?.n ?? 0;
}

export const checkDualWriteHandler: QueryHandler<
  QueryParams,
  CheckDualWriteResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const db = openDb();
  const verbose = params["verbose"] === "1";
  const restrictDid = params["did"];

  // Resolve the set of spaces to check: one stream, or every materialized space.
  let spaceDids: string[];
  if (typeof restrictDid === "string" && restrictDid !== "") {
    StreamDid.assert(restrictDid); // throws on invalid DID
    spaceDids = [restrictDid];
  } else {
    const rows = await db
      .query("select distinct stream_id from entities where stream_id = id")
      .all<{ stream_id: string }>();
    spaceDids = rows.map((r) => r.stream_id);
  }

  const spaces: SpaceReport[] = [];

  for (const did of spaceDids) {
    const spaceDb = db.forSpace(did);
    const globalDb = db.global();

    // Mono (source of truth) counts.
    const mono = {
      comp_room: await monoTableCount(db, did, "comp_room"),
      comp_content: await monoTableCount(db, did, "comp_content"),
      comp_space: await monoTableCount(db, did, "comp_space"),
      comp_info: await monoTableCount(db, did, "comp_info"),
      membership: {
        joinedSpace: await membershipCount(db, did, "joinedSpace"),
        leftSpace: await membershipCount(db, did, "leftSpace"),
      },
    };

    // Per-space counts (should mirror mono for stream tables, hold no membership).
    const perSpace = {
      comp_room: await perSpaceTableCount(spaceDb, "comp_room"),
      comp_content: await perSpaceTableCount(spaceDb, "comp_content"),
      comp_space: await perSpaceTableCount(spaceDb, "comp_space"),
      comp_info: await perSpaceTableCount(spaceDb, "comp_info"),
      membership: {
        joinedSpace: await membershipCount(spaceDb, did, "joinedSpace"),
        leftSpace: await membershipCount(spaceDb, did, "leftSpace"),
      },
    };

    // Global membership (should mirror mono membership).
    const global = {
      joinedSpace: await membershipCount(globalDb, did, "joinedSpace"),
      leftSpace: await membershipCount(globalDb, did, "leftSpace"),
    };

    // Build the diff list.
    const diffs: string[] = [];
    for (const t of STREAM_TABLES) {
      if (mono[t] !== perSpace[t]) {
        diffs.push(
          `${t}: mono=${mono[t]} perSpace=${perSpace[t]}`,
        );
      }
    }
    for (const l of MEMBERSHIP_LABELS) {
      // Membership must never live in the per-space DB (it routes to global).
      if (perSpace.membership[l] !== 0) {
        diffs.push(`membership ${l} in per-space (expected 0): perSpace=${perSpace.membership[l]}`);
      }
      // Global membership must mirror the monolithic (source-of-truth) DB.
      if (mono.membership[l] !== global[l]) {
        diffs.push(`membership ${l}: mono=${mono.membership[l]} global=${global[l]}`);
      }
    }

    spaces.push({
      streamDid: did,
      status: diffs.length === 0 ? "ok" : "diverged",
      diffs,
      ...(verbose ? { counts: { mono, perSpace, global } } : {}),
    });
  }

  return {
    checked: spaces.length,
    diverged: spaces.filter((s) => s.status === "diverged").length,
    spaces,
  };
};
