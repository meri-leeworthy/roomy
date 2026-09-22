/**
 * Thread activity helper.
 *
 * Used by `space.getThreads`, `room.getThreads`, and the `recentThreads` field
 * of `room.getMetadata`. Returns each thread with its latest message timestamp
 * and up to 3 unique recent participants.
 *
 * Forwarded messages are forward-reference entities with no own content/author
 * — their timestamp and author live on the original message reached via the
 * `forward` edge. We follow that edge (coalescing the message's own content
 * with the forwarded original's) so a thread created by forwarding messages
 * still reports a latest timestamp, recent participants (the original authors),
 * and a latest message — matching what `selectMessages` displays.
 *
 * Implementation note: the equivalent frontend LiveQuery used a window function
 * with `partition by author` over a SELECT alias and silently returned 0–1
 * members because window functions evaluate before aliases (memory:
 * 2026-01-30). We sidestep that here by using a per-thread aggregate with
 * `json_group_array(distinct ...)` over the top-N most recent messages.
 */

import type { DbLike } from "../db/types.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";
import { hydrateProfiles } from "./profileStore.ts";
import { readRoomActivityProjection, rebuildRoomActivity, warnProjectionUnavailable } from "./roomActivityProjection.ts";

export interface ThreadMember {
  did: string;
  name: string | null;
  avatar: string | null;
}

export interface ThreadMessage {
  id: string;
  content: string;
  author: ThreadMember;
  timestamp: string | null;
}

export interface ThreadActivity {
  id: string;
  /** `thread` (canonically linked from a channel) or `channel`. */
  kind: "thread" | "channel";
  name: string | null;
  /** Canonical parent channel ID (head of the canonical 'link' edge), null if none. */
  canonicalParent: string | null;
  /** Latest message timestamp in this room (ISO string), null if no messages. */
  latestTimestamp: string | null;
  latestMembers: ThreadMember[];
  /** The most recent message in this room, null if no messages. */
  latestMessage: ThreadMessage | null;
}

export type ThreadScope =
  | { kind: "space"; spaceId: string }
  | { kind: "channel"; channelId: string };

export interface ListActivityOptions {
  /** Room kinds to include (defaults to `["thread"]`). */
  kinds?: Array<"thread" | "channel">;
}

/**
 * Rooms visible in this scope with activity metadata.
 *
 * Space scope can include channels via `opts.kinds` (the space index board);
 * channel scope is always threads. Each row carries its `kind`.
 *
 * Supports cursor-based pagination via the `activity_item` table's
 * `last_activity_at` column. Cursor format: `"<last_activity_at>::<room_id>"`.
 * Returns at most `limit` rooms (default 50), plus a `cursor` for the next
 * page (null when there are no more results).
 *
 * Rooms with no messages (no `activity_item` row) get sort key 0, so they
 * sort last (after all active rooms) and don't block pagination past active
 * rooms.
 *
 * The caller is responsible for filtering by read access — this helper does
 * not check permissions.
 */
export async function listThreadActivity(
  db: DbLike,
  scope: ThreadScope,
  limit = 50,
  cursor?: string | null,
  search?: string | null,
  opts: ListActivityOptions = {},
): Promise<{ threads: ThreadActivity[]; cursor: string | null }> {
  // Step 1: select the candidate rooms in scope, with cursor pagination.
  // LEFT JOIN activity_item so we can order/filter by last_activity_at even
  // for rooms with no messages (they get NULL -> COALESCE to 0).
  let cursorTs: number | null = null;
  let cursorId: string | null = null;
  if (cursor) {
    const sepIdx = cursor.lastIndexOf("::");
    if (sepIdx !== -1) {
      cursorTs = Number(cursor.slice(0, sepIdx));
      cursorId = cursor.slice(sepIdx + 2);
    }
  }

  const kinds = opts.kinds ?? ["thread"];
  if (kinds.length === 0) return { threads: [], cursor: null };

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (scope.kind === "space") {
    conditions.push("e.stream_id = ?");
    params.push(scope.spaceId);
  } else {
    conditions.push("link_e.head = ?");
    params.push(scope.channelId);
  }
  conditions.push(`cr.label in (${kinds.map(() => "?").join(",")})`);
  params.push(
    ...kinds.map((k) => (k === "thread" ? "space.roomy.thread" : "space.roomy.channel")),
  );
  conditions.push("coalesce(cr.deleted, 0) = 0");

  // Optional case-insensitive substring filter on room name. Applied in
  // SQL (not JS) so cursor pagination stays correct — filtering after the
  // page fetch would skip matches and misalign the cursor.
  if (search && search.trim() !== "") {
    conditions.push("ci.name like ?");
    params.push(`%${search.trim()}%`);
  }

  // Cursor: newest-first by last_activity_at, tiebreak by room_id.
  if (cursorTs !== null && cursorId !== null) {
    conditions.push(
      "(coalesce(ai.last_activity_at, 0) < ? or (coalesce(ai.last_activity_at, 0) = ? and e.id > ?))",
    );
    params.push(cursorTs, cursorTs, cursorId);
  }

  const whereClause = conditions.join(" and ");

  const joinClause = scope.kind === "space"
    ? ""
    : "join edges link_e on link_e.tail = e.id and link_e.label = 'link' and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1";

  const threads = await db
    .query(
      `select e.id as id, ci.name as name, cr.label as label,
              coalesce(ai.last_activity_at, 0) as sort_key
         from entities e
         join comp_room cr on cr.entity = e.id
         left join comp_info ci on ci.entity = e.id
         left join activity_item ai on ai.room_id = e.id
         ${joinClause}
        where ${whereClause}
        order by sort_key desc, e.id asc
        limit ?`,
    )
    .all<{ id: string; name: string | null; label: string | null; sort_key: number }>([...params, limit + 1]);

  if (threads.length === 0) return { threads: [], cursor: null };

  // Check if there are more pages (we fetched one extra row).
  const hasMore = threads.length > limit;
  const pageThreads = hasMore ? threads.slice(0, limit) : threads;

  const threadIds = pageThreads.map((t) => t.id);
  const activityByRoom = await fetchRoomActivity(db, threadIds);

  const results: ThreadActivity[] = pageThreads.map((t) => {
    const act = activityByRoom.get(t.id);
    return {
      id: t.id,
      kind: t.label === "space.roomy.channel" ? "channel" : "thread",
      name: t.name,
      canonicalParent: act?.canonicalParent ?? null,
      latestTimestamp: act?.latestTimestamp ?? null,
      latestMembers: act?.latestMembers ?? [],
      latestMessage: act?.latestMessage ?? null,
    };
  });

  // Compute next cursor from the last visible thread.
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageThreads[pageThreads.length - 1]!;
    nextCursor = `${last.sort_key}::${last.id}`;
  }

  return { threads: results, cursor: nextCursor };
}

/**
 * Batch-fetch activity metadata for a set of rooms: latest message timestamp,
 * up to 3 unique recent participants, canonical parent channel, and the latest
 * message (content decoded to plaintext). Shared by `listThreadActivity` and
 * `space.roomy.search.rooms` so search results render with the same activity
 * columns as the board views.
 *
 * Served from the `room_activity` projection (TASK-175), which holds the same
 * facts reduced once per write. `scanRoomActivity` below is the fallback: the
 * projection is an optimisation and a page it cannot answer in full is read the
 * old way, from the messages themselves.
 *
 * Rooms with no messages are absent from the map (or carry empty arrays) —
 * callers treat that as "no activity".
 */
export async function fetchRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity>> {
  if (roomIds.length === 0) return new Map();

  const projected = await fetchProjectedRoomActivity(db, roomIds);
  const out = projected ?? (await scanRoomActivity(db, roomIds));

  // Warm on miss — the `room_access` pattern (queries/roomAccessProjection.ts).
  // The scan below has just derived every room's answer from the live tables, so
  // writing those rows now means this page is projected from the next read on.
  //
  // Without this, the projection could never cover a room with no messages: no
  // message event exists to maintain its row, and because a page is projected
  // only when EVERY room in it is, a single quiet room would send the whole board
  // back to the scan permanently. It is also what heals a blue-green rebuild,
  // where rematerialisation deliberately invalidates without populating.
  //
  // Best-effort: the caller already holds a correct answer, so a failed warm must
  // never turn a successful read into an error.
  if (!projected) {
    try {
      await rebuildRoomActivity(db, roomIds);
    } catch (err) {
      warnProjectionUnavailable(err);
    }
  }

  // Resolve participant + latest-message author profiles from the global store
  // (with an in-memory cache). A user's profile entity lives in their own
  // stream, not this space's stream, so the per-space comp_info join is null
  // for cross-stream users. The global `profiles` table is authoritative; the
  // per-space value (if any) acts as a fallback. Shared by both paths so a
  // projected row and a scanned row hydrate identically.
  const membersToHydrate: ThreadMember[] = [];
  for (const t of out.values()) {
    membersToHydrate.push(...t.latestMembers);
    if (t.latestMessage?.author) membersToHydrate.push(t.latestMessage.author);
  }
  await hydrateProfiles(
    membersToHydrate,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );

  return out;
}

/**
 * The pre-projection implementation: derive each room's activity from its
 * messages. Kept as the fallback for a page the projection cannot answer — a
 * room whose row was invalidated, or a handle whose schema predates the table.
 *
 * Its cost is O(messages in scope) — SQLite has no `LIMIT` per group, so the
 * latest message is picked by reading every message in every requested room and
 * reducing in JS (measured: 8001 rows to keep 2 at 8000 messages). That is what
 * the projection replaces.
 */
async function scanRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity>> {
  const out = new Map<string, ThreadActivity>();
  if (roomIds.length === 0) return out;

  const ph = roomIds.map(() => "?").join(",");

  // Latest timestamps for all rooms at once.
  const latestRows = await db
    .query(
      `select e.room as room,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
        group by e.room`,
    )
    .all<{ room: string; ts: number | null }>([...roomIds]);
  const latestMap = new Map(latestRows.map((r) => [r.room, r.ts]));

  // Recent participants (up to 3 per room). For forwarded messages the
  // author edge lives on the original (reached via the `forward` edge), so
  // we coalesce the message's own author with the forwarded original's.
  const participantRows = await db
    .query(
      `select msg.room as room,
              coalesce(author_e.tail, fwd_author_e.tail) as did,
              ci.name as name,
              ci.avatar as avatar,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities msg
         left join comp_content cc on cc.entity = msg.id
         left join edges author_e
           on author_e.head = msg.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = msg.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info ci
           on ci.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where msg.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
          and coalesce(author_e.tail, fwd_author_e.tail) is not null
        group by msg.room, coalesce(author_e.tail, fwd_author_e.tail)
        order by msg.room, ts desc, coalesce(author_e.tail, fwd_author_e.tail) asc`,
    )
    .all<{ room: string; did: string; name: string | null; avatar: string | null; ts: number | null }>([...roomIds]);

  const participantsMap = new Map<string, ThreadMember[]>();
  for (const r of participantRows) {
    let arr = participantsMap.get(r.room);
    if (!arr) {
      arr = [];
      participantsMap.set(r.room, arr);
    }
    if (arr.length < 3) {
      arr.push({ did: r.did, name: r.name, avatar: r.avatar });
    }
  }

  // Canonical parent per room.
  const parentRows = await db
    .query(
      `select tail, head from edges
        where tail in (${ph})
          and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
    )
    .all<{ tail: string; head: string }>([...roomIds]);
  const parentMap = new Map(parentRows.map((r) => [r.tail, r.head]));

  // Room kind and name. `fetchRoomActivity` is used by the search handler, which
  // matches channels and threads alike, so the kind must come from the room's
  // own label rather than being assumed to be a thread.
  const roomRows = await db
    .query(
      `select cr.entity as room_id, cr.label as label, ci.name as name
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
        where cr.entity in (${ph})`,
    )
    .all<{ room_id: string; label: string | null; name: string | null }>([...roomIds]);
  const roomKinds = new Map(roomRows.map((r) => [r.room_id, r.label]));
  const roomNames = new Map<string, string>();
  for (const r of roomRows) if (r.name != null) roomNames.set(r.room_id, r.name);
  // Latest message per room. SQLite doesn't support LIMIT per group, so we
  // fetch all messages and pick the latest per room in JS.
  const latestMsgRows = await db
    .query(
      `select e.room as room,
              e.id as id,
              coalesce(cc.mime_type, fwd_cc.mime_type) as mime_type,
              coalesce(cc.data, fwd_cc.data) as data,
              coalesce(author_e.tail, fwd_author_e.tail) as author_did,
              author_info.name as author_name,
              author_info.avatar as author_avatar,
              coalesce(cc.timestamp, fwd_cc.timestamp) as timestamp
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info author_info
           on author_info.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
          and coalesce(cc.timestamp, fwd_cc.timestamp) is not null`,
    )
    .all<
      {
        room: string;
        id: string;
        mime_type: string | null;
        data: Buffer | Uint8Array | null;
        author_did: string | null;
        author_name: string | null;
        author_avatar: string | null;
        timestamp: number | null;
      }
    >([...roomIds]);

  const latestMsgMap = new Map<
    string,
    {
      id: string;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      author_did: string | null;
      author_name: string | null;
      author_avatar: string | null;
      timestamp: number | null;
    }
  >();
  for (const r of latestMsgRows) {
    const existing = latestMsgMap.get(r.room);
    // Newest timestamp wins; a tie breaks by message id. The tie-break is
    // shared with the `room_activity` projection, which cannot otherwise agree
    // with this fold: two messages can share a millisecond (a pair created
    // together, or bridged messages carrying sender-supplied times), and
    // without a stated rule each path would pick whichever row it happened to
    // see first.
    if (
      !existing ||
      (r.timestamp ?? 0) > (existing.timestamp ?? 0) ||
      ((r.timestamp ?? 0) === (existing.timestamp ?? 0) && r.id > existing.id)
    ) {
      latestMsgMap.set(r.room, r);
    }
  }

  for (const roomId of roomIds) {
    const latest = latestMap.get(roomId);
    const members = participantsMap.get(roomId) ?? [];
    const parent = parentMap.get(roomId);
    const latestMsgRow = latestMsgMap.get(roomId);

    let latestMessage: ThreadMessage | null = null;
    if (latestMsgRow && latestMsgRow.author_did) {
      latestMessage = {
        id: latestMsgRow.id,
        content: decodeBoardPreview(latestMsgRow.mime_type, latestMsgRow.data),
        author: {
          did: latestMsgRow.author_did,
          name: latestMsgRow.author_name,
          avatar: latestMsgRow.author_avatar,
        },
        timestamp: latestMsgRow.timestamp
          ? new Date(latestMsgRow.timestamp).toISOString()
          : null,
      };
    }

    out.set(roomId, {
      id: roomId,
      kind: roomKinds.get(roomId) === "space.roomy.channel" ? "channel" : "thread",
      name: roomNames.get(roomId) ?? null,
      canonicalParent: parent ?? null,
      latestTimestamp: latest ? new Date(latest).toISOString() : null,
      latestMembers: members,
      latestMessage,
    });
  }

  return out;
}

/**
 * Decode a message body to the plaintext a board row previews.
 *
 * Rich-text bodies are base64-encoded on the wire (`decodeContent` base64s
 * non-text mimeTypes), so they decode to blocks and then to plaintext — a board
 * must show readable text, not the encoded blob. Legacy `text/*` content is
 * already plaintext and passes through. Shared by the projection read and the
 * live scan so both render the same preview from the same row.
 */
function decodeBoardPreview(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (mime === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(mime, data);
    return blocks ? blocksToPlaintext(blocks) : "";
  }
  return decodeContent(mime, data);
}

/**
 * Serve the batch from the `room_activity` projection.
 *
 * Two round-trips for the whole page, neither growing with the number of
 * messages in it: one read of the reduced rows (latest message id + timestamp,
 * distinct authors by their newest message) and one for the board shape the
 * caller needs (kind, name, canonical parent, and the latest message's decoded
 * content).
 *
 * Returns `null` when the projection cannot answer the whole page — the table is
 * missing, or at least one requested room has no row — which sends the caller to
 * the live scan. A partially-projected answer is deliberately not assembled; see
 * `readRoomActivityProjection`.
 */
async function fetchProjectedRoomActivity(
  db: DbLike,
  roomIds: string[],
): Promise<Map<string, ThreadActivity> | null> {
  const projected = await readRoomActivityProjection(db, roomIds);
  if (!projected) return null;

  const ph = roomIds.map(() => "?").join(",");

  // Room shape + latest-message content, one row per room. The content columns
  // are the decoded message the board previews; `coalesce` picks the forwarded
  // original's for a legacy forward reference, which has none of its own.
  const roomRows = await db
    .query(
      `select cr.entity as room_id,
              cr.label as label,
              ci.name as name,
              p.head as parent_id,
              ra.latest_message_id as latest_message_id,
              coalesce(mc.mime_type, fc.mime_type) as mime_type,
              coalesce(mc.data, fc.data) as data,
              coalesce(a.tail, fa.tail) as author_did
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
         left join edges p
                on p.tail = cr.entity and p.label = 'link'
               and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
         left join room_activity ra on ra.room_id = cr.entity
         left join entities m on m.id = ra.latest_message_id
         left join comp_content mc on mc.entity = m.id
         left join edges a on a.head = m.id and a.label = 'author'
         left join edges f on f.head = m.id and f.label = 'forward'
         left join comp_content fc on fc.entity = f.tail
         left join edges fa on fa.head = f.tail and fa.label = 'author'
        where cr.entity in (${ph})`,
    )
    .all<{
      room_id: string;
      label: string | null;
      name: string | null;
      parent_id: string | null;
      latest_message_id: string | null;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      author_did: string | null;
    }>(...roomIds);

  // A requested id with no `comp_room` row is not a room at all — the caller
  // asked for something this projection has no board row for, so it cannot
  // answer the page.
  if (roomRows.length !== roomIds.length) return null;

  // Every author who can appear in the page's `latestMembers`, in one read
  // rather than one per room. Names/avatars come from the per-space `comp_info`;
  // `hydrateProfiles` in the caller then layers the global store over whatever
  // this finds, as it does for the scanned path.
  const memberDids = new Set<string>();
  for (const row of projected.values()) {
    for (const a of row.authors) memberDids.add(a.did);
  }
  const members = new Map<string, { name: string | null; avatar: string | null }>();
  if (memberDids.size > 0) {
    const dids = [...memberDids];
    const infoRows = await db
      .query(
        `select entity, name, avatar from comp_info
          where entity in (${dids.map(() => "?").join(",")})`,
      )
      .all<{ entity: string; name: string | null; avatar: string | null }>(...dids);
    for (const r of infoRows) members.set(r.entity, { name: r.name, avatar: r.avatar });
  }

  const out = new Map<string, ThreadActivity>();
  for (const row of roomRows) {
    const projection = projected.get(row.room_id)!;
    const author = row.author_did != null ? members.get(row.author_did) : undefined;

    const latestMessage: ThreadMessage | null =
      row.latest_message_id != null && row.author_did != null
        ? {
            id: row.latest_message_id,
            content: decodeBoardPreview(row.mime_type, row.data),
            author: {
              did: row.author_did,
              name: author?.name ?? null,
              avatar: author?.avatar ?? null,
            },
            timestamp:
              projection.latestAt != null
                ? new Date(projection.latestAt).toISOString()
                : null,
          }
        : null;

    out.set(row.room_id, {
      id: row.room_id,
      kind: row.label === "space.roomy.channel" ? "channel" : "thread",
      name: row.name,
      canonicalParent: row.parent_id,
      latestTimestamp:
        projection.latestAt != null
          ? new Date(projection.latestAt).toISOString()
          : null,
      latestMembers: projection.authors.slice(0, 3).map((a) => {
        const p = members.get(a.did);
        return { did: a.did, name: p?.name ?? null, avatar: p?.avatar ?? null };
      }),
      latestMessage,
    });
  }

  return out;
}
