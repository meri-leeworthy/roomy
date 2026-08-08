/**
 * XRPC: space.roomy.admin.listSpaces (query).
 *
 * Paginated, per-space stats for the admin dashboard. Each row carries
 * member/event counters and an event-type breakdown for one space, sorted
 * by member count descending (ties broken by space DID ascending so the
 * order is stable across pages).
 *
 * The cursor is `"<memberCount>|<did>"` of the last row on the current
 * page; the next page starts strictly after that (member count, did)
 * under the same sort. Capped at 100 rows per page.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb, openSpaceDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { optionalInt, optionalString } from "../xrpc/params.ts";
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Parse the opaque cursor into `{ memberCount, did }`. Returns null when
 * the cursor is absent or malformed (the handler treats null as "first
 * page" rather than erroring, so a stale client cursor degrades to a
 * fresh first page instead of a 400).
 *
 * The cursor is `"<memberCount>|<did>"`; `|` is chosen because it never
 * appears in a DID (`did:plc:` / `did:web:` use only colons).
 */
function parseCursor(cursor: string): { memberCount: number; did: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const count = Number(cursor.slice(0, sep));
  const did = cursor.slice(sep + 1);
  if (!Number.isInteger(count) || count < 0 || did.length === 0) return null;
  return { memberCount: count, did };
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
  // (memberCount, did) under (member_count desc, did asc) ordering — i.e.
  // member_count < cursor.memberCount, OR equal member_count AND did >
  // cursor.did.
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

  // Sort by member count desc, ties broken by did asc so the order is
  // stable across pages.
  spaceStats.sort(
    (a, b) =>
      b.member_count - a.member_count ||
      (a.did < b.did ? -1 : a.did > b.did ? 1 : 0),
  );

  let paged = spaceStats;
  if (cursor) {
    paged = spaceStats.filter(
      (s) =>
        s.member_count < cursor.memberCount ||
        (s.member_count === cursor.memberCount && s.did > cursor.did),
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
    result.cursor = `${last.member_count}|${last.did}`;
  }
  return result;
};