/**
 * XRPC: space.roomy.admin.listSpaces (query).
 *
 * Paginated, per-space stats for the admin dashboard. Each row carries
 * member/event counters and an event-type breakdown for one space. Rows
 * are ordered numerically descending by the active sort key
 * (`memberCount` | `totalEvents` | `eventsToday`, default `memberCount`),
 * ties broken by space DID ascending so the order is stable across pages.
 *
 * The cursor is `"<sortValue>|<did>"` of the last row on the current page,
 * where `<sortValue>` is that row's value under the ACTIVE sort key — the
 * number the cursor filters against is the same one the ORDER BY used, so
 * paging never re-visits or skips rows when a non-default sort is in
 * effect. The next page starts strictly after that (sort value, did) under
 * the same sort. Capped at 100 rows per page.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb, openSpaceDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { optionalInt, optionalString } from "../xrpc/params.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface AdminSpaceStats {
  did: string;
  name: string;
  memberCount: number;
  totalEvents: number;
  eventsToday: number;
  eventBreakdown: Record<string, number>;
}

export interface ListSpacesResult {
  spaces: AdminSpaceStats[];
  cursor?: string;
}

/** The supported sort keys for the per-space list. */
export type ListSpacesSort = "memberCount" | "totalEvents" | "eventsToday";

const SORTS: readonly ListSpacesSort[] = [
  "memberCount",
  "totalEvents",
  "eventsToday",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Parse the opaque cursor into `{ sortValue, did }`. Returns null when
 * the cursor is absent or malformed (the handler treats null as "first
 * page" rather than erroring, so a stale client cursor degrades to a
 * fresh first page instead of a 400).
 *
 * The cursor is `"<sortValue>|<did>"`, where `<sortValue>` is the last
 * row's value under the ACTIVE sort key; `|` is chosen because it never
 * appears in a DID (`did:plc:` / `did:web:` use only colons).
 */
function parseCursor(
  cursor: string,
): { sortValue: number; did: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const sortValue = Number(cursor.slice(0, sep));
  const did = cursor.slice(sep + 1);
  if (!Number.isInteger(sortValue) || sortValue < 0 || did.length === 0)
    return null;
  return { sortValue, did };
}

/** Parse the `sort` query param, defaulting to `memberCount`. */
function parseSort(params: QueryParams): ListSpacesSort {
  const raw = optionalString(params, "sort");
  if (raw === undefined) return "memberCount";
  if ((SORTS as readonly string[]).includes(raw)) return raw as ListSpacesSort;
  throw new XrpcError(
    400,
    "InvalidRequest",
    `Param sort must be one of: ${SORTS.join(", ")}; got: ${raw}`,
  );
}

/** Extract the sort key's numeric value from a space-stats row. */
function sortValueOf(
  sort: ListSpacesSort,
  s: { member_count: number; total_events: number; events_today: number },
): number {
  switch (sort) {
    case "memberCount":
      return s.member_count;
    case "totalEvents":
      return s.total_events;
    case "eventsToday":
      return s.events_today;
  }
}

export const adminListSpacesHandler: QueryHandler<
  QueryParams,
  ListSpacesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const limit = optionalInt(params, "limit", {
    min: 1,
    max: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  });
  const sort = parseSort(params);
  const cursorRaw = optionalString(params, "cursor") ?? null;
  const cursor = cursorRaw ? parseCursor(cursorRaw) : null;

  const eventsDb = openDb();
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();

  // ── Enumerate spaces + event counters from the event-log DB ─────────────
  //
  // Phase 3: there is no monolithic DB to enumerate `comp_space` from, and
  // `stream_events` is no longer ATTACHed to the same handle as the
  // materialised tables. The event-log DB (openDb) is the source of the
  // space list: every space has a stream, and every stream with events is
  // counted here. Per-space details (member edges, comp_space/comp_info)
  // are read from each space's per-space DB via openSpaceDb(spaceDid)
  // below.
  const eventRows = await eventsDb
    .query(
      `select stream_id,
              count(*) as total_events,
              count(case when created_at >= ? then 1 end) as events_today
         from stream_events
        group by stream_id`,
    )
    .all<{
      stream_id: string;
      total_events: number;
      events_today: number;
    }>(todayStart);

  // ── Per-space aggregates ────────────────────────────────────────────────
  //
  // Member count is a count over `edges` (head = space, label in
  // ('member','admin')); name comes from comp_info. Both live in the
  // per-space DB. Event counters come from the grouped event-log query
  // above. The cursor filter preserves the sort: rows strictly after
  // (sortValue, did) under (sortValue desc, did asc) ordering — i.e.
  // sortValue < cursor.sortValue, OR equal sortValue AND did > cursor.did.
  const spaceStats: Array<{
    did: string;
    name: string | null;
    member_count: number;
    total_events: number;
    events_today: number;
  }> = [];

  for (const r of eventRows) {
    const spaceDb = openSpaceDb(r.stream_id);
    const spaceRow = await spaceDb
      .query(
        `select
           (select count(*) from edges
             where head = cs.entity and label in ('member','admin')
           ) as member_count,
           ci.name as name
         from comp_space cs
         left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?`,
      )
      .get<{ member_count: number; name: string | null }>(r.stream_id);

    spaceStats.push({
      did: r.stream_id,
      name: spaceRow?.name ?? null,
      member_count: spaceRow?.member_count ?? 0,
      total_events: r.total_events,
      events_today: r.events_today,
    });
  }

  // Sort by the active key desc, ties broken by did asc so the order is
  // stable across pages. `sortValueOf` reads the same field the cursor
  // encodes, so the cursor filter stays consistent with the ORDER BY.
  spaceStats.sort(
    (a, b) =>
      sortValueOf(sort, b) - sortValueOf(sort, a) ||
      (a.did < b.did ? -1 : a.did > b.did ? 1 : 0),
  );

  let paged = spaceStats;
  if (cursor) {
    const cv = cursor.sortValue;
    paged = spaceStats.filter(
      (s) =>
        sortValueOf(sort, s) < cv ||
        (sortValueOf(sort, s) === cv && s.did > cursor.did),
    );
  }

  // Fetch one extra row to detect a next page without a second query.
  const pageRows = paged.slice(0, limit + 1);
  const hasMore = pageRows.length > limit;
  const visibleRows = hasMore ? pageRows.slice(0, limit) : pageRows;

  // ── Event-type breakdown per space (one grouped query per space) ──────
  const spaces: AdminSpaceStats[] = [];
  for (const r of visibleRows) {
    const breakdownRows = await eventsDb
      .query(
        `select event_type, count(*) as n
           from stream_events
          where stream_id = ? and event_type is not null
          group by event_type
          order by n desc`,
      )
      .all<{ event_type: string; n: number }>(r.did);

    const eventBreakdown: Record<string, number> = {};
    for (const b of breakdownRows) {
      eventBreakdown[b.event_type] = b.n;
    }

    spaces.push({
      did: r.did,
      name: r.name ?? r.did,
      memberCount: r.member_count,
      totalEvents: r.total_events,
      eventsToday: r.events_today,
      eventBreakdown,
    });
  }

  const result: ListSpacesResult = { spaces };
  if (hasMore && visibleRows.length > 0) {
    const last = visibleRows[visibleRows.length - 1]!;
    // Encode the ACTIVE sort key's value — the number the next page's
    // cursor predicate filters against must match the ORDER BY used.
    result.cursor = `${sortValueOf(sort, last)}|${last.did}`;
  }
  return result;
};