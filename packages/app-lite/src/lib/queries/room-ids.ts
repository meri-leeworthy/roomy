/**
 * The client's room index — the room ids it currently holds — so a reply
 * preview can decide "this target is a room, not a message" without asking.
 *
 * Why it exists: `space.roomy.message.getMessage` resolves its argument as a
 * message and answers `400 InvalidRequest "Entity <id> is not a message (no
 * room)"` for anything else, because a message is the only entity type
 * carrying a `room` column. A reply attachment's `target` can name any entity
 * id, so a reply whose target is a room asks a question whose answer can never
 * change: a permanent 400 on every render of that reply. The client already
 * holds the rooms — the sidebar and the boards *are* room listings it renders
 * — so a failing id is knowable before the request is issued.
 *
 * An earlier guard covered only the case where the target IS the room the
 * reply lives in. The rejection rule it mirrors is wider than that: any room
 * id fails, including a *different* room's — a cross-room channel, or a thread
 * of the room being read. Production carried exactly that shape (lobby replies
 * targeting a thread id), which the own-room guard could not see.
 *
 * Sound in one direction only, which is what the guard needs: an id read out
 * of a room listing IS a room (those listings select room rows), so
 * `getMessage` on it is guaranteed to fail and the request is pure waste. An
 * id absent here is merely unknown, and the caller still asks the appserver —
 * the guard never suppresses a lookup that could have succeeded.
 *
 * Extraction is path-based rather than per-NSID code, so adding a listing is
 * one row in {@link ROOM_ID_PATHS}. Payloads arrive as `unknown` — they are
 * per-NSID responses, not a common shape — and are walked defensively: a shape
 * change narrows the guard back to asking, it never throws.
 */

/** The slice of a TanStack cache entry the room index reads. */
export interface RoomIndexEntry {
  /** `cache.queryKey(nsid, params)` → `[nsid]`, or `[nsid, params]`. */
  readonly queryKey: readonly unknown[];
  /** TanStack query state; `data` is the cached response for `queryKey`. */
  readonly state: { readonly data: unknown };
}

/**
 * A field path into a response payload. `"*"` maps over an array at that
 * position; the last segment is an id field. See {@link collectIds}.
 */
type IdPath = readonly (string | "*")[];

/**
 * Where each room-listing response keeps its room ids.
 *
 * Only listings that name *rooms* belong here: the sidebar the client
 * renders, the space index board, and the two per-channel board queries.
 */
const ROOM_ID_PATHS: Record<string, readonly IdPath[]> = {
  "space.roomy.space.getMetadata": [
    ["sidebar", "categories", "*", "channels", "*", "id"],
    ["sidebar", "categories", "*", "channels", "*", "activeThreads", "*", "id"],
    ["sidebar", "orphans", "*", "id"],
    ["sidebar", "orphans", "*", "activeThreads", "*", "id"],
    // A deleted room is still a room entity, so a reply targeting one 400s the
    // same way; the sidebar lists them for the restore flow.
    ["deletedRooms", "*", "id"],
  ],
  "space.roomy.space.getThreads": [["pages", "*", "rooms", "*", "id"]],
  "space.roomy.room.getThreads": [["pages", "*", "threads", "*", "id"]],
  "space.roomy.search.rooms": [["rooms", "*", "id"]],
};

/**
 * Whether a query key names a room *listing* — the responses the room index
 * reads. Callers watching the cache use this to ignore changes that cannot
 * affect the index (a message diff, say) instead of recomputing on all of
 * them.
 */
export function isRoomListingKey(queryKey: readonly unknown[]): boolean {
  const nsid = queryKey[0];
  return typeof nsid === "string" && nsid in ROOM_ID_PATHS;
}

/**
 * Whether a query key can affect the room index: a room *listing* response
 * (the payloads {@link scanRoomIndex} reads), or any query keyed by a
 * `roomId` param. Callers watching the cache filter on this so changes that
 * cannot change the index — a message diff, an observer result update — do not
 * recompute it.
 */
export function isRoomIndexKey(queryKey: readonly unknown[]): boolean {
  if (isRoomListingKey(queryKey)) return true;
  const keyed = fieldOf(queryKey[1], "roomId");
  return typeof keyed === "string" && keyed !== "";
}

/** Read one field off an unknown-shaped payload without asserting its type. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Walk `path` into `payload`, adding every id string it reaches to `into`. */
function collectIds(payload: unknown, path: IdPath, into: Set<string>): void {
  if (path.length === 0) {
    if (typeof payload === "string" && payload !== "") into.add(payload);
    return;
  }
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (head === "*") {
    if (Array.isArray(payload)) {
      for (const item of payload) collectIds(item, rest, into);
    }
    return;
  }
  collectIds(fieldOf(payload, head), rest, into);
}

/**
 * What the cache says about rooms: the ids it names, and whether it has
 * answered at all.
 *
 * The two facts are separate on purpose. A cold load holds an empty index
 * because nothing has arrived yet, not because nothing is a room, so a caller
 * that reads an empty {@link rooms} as "this id is not a room" asks the very
 * question the index exists to answer — once per cold load, per id.
 */
export interface RoomIndex {
  /** Room ids named by the cached listings and by room-keyed cache keys. */
  readonly rooms: ReadonlySet<string>;
  /**
   * Whether at least one room-listing response has been cached. Until then
   * nothing follows from an id's absence.
   */
  readonly ready: boolean;
}

/**
 * Read the room index out of cache entries.
 *
 * Every room id the entries name: the ids listed by each room-listing
 * response, plus the `roomId` param of every cached key — a query keyed by a
 * room id (the room page, its board, its message list) is keyed by a room by
 * construction. `ready` is the second half: whether any listing response has
 * been cached at all.
 */
export function scanRoomIndex(entries: Iterable<RoomIndexEntry>): RoomIndex {
  const rooms = new Set<string>();
  let ready = false;
  for (const entry of entries) {
    const nsid = entry.queryKey[0];
    if (typeof nsid !== "string") continue;

    if (!ready && isRoomListingKey(entry.queryKey) && entry.state.data != null) {
      ready = true;
    }

    const keyed = fieldOf(entry.queryKey[1], "roomId");
    if (typeof keyed === "string" && keyed !== "") rooms.add(keyed);

    for (const path of ROOM_ID_PATHS[nsid] ?? []) {
      collectIds(entry.state.data, path, rooms);
    }
  }
  return { rooms, ready };
}

/**
 * Whether the client can name `roomId` as one of its rooms: the index has
 * answered, and it names the id.
 *
 * This is the precondition for touching a room through the network on the
 * client's own initiative — a link-card summary, say — rather than because the
 * reader asked. An id the index does not name is either a message or a room
 * the client has never listed; only the reader's own navigation should spend a
 * request finding out which.
 */
export function isIndexedRoom(roomId: string, index: RoomIndex): boolean {
  return index.ready && index.rooms.has(roomId);
}

/**
 * Whether the reply preview may ask `getMessage` about `target`.
 *
 * Three ways the answer is no:
 *
 *  - the target is empty: there is nothing to ask about;
 *  - the target is the room the reply lives in — not a message, knowable with
 *    no cache at all;
 *  - the room index names the target: it is a room, and `getMessage` rejects
 *    every entity that is not a message. The index covers the rooms *other*
 *    than the reply's own — a cross-room channel, a thread of the room being
 *    read — which is the shape an own-room-only comparison missed.
 *
 * The fourth case is why this takes the whole {@link RoomIndex} rather than its
 * set: before any listing has been cached the index is empty because nothing
 * has arrived, and asking then turns a cold load into a 400 for every reply
 * whose target is a room. The answer is knowable a moment later, so the query
 * waits for it — an effect reading this re-runs when the listing lands, and
 * only then does an id's absence mean the target might be a message.
 */
export function mayAskForReplyTarget(
  target: string,
  ownRoomId: string | undefined,
  index: RoomIndex,
): boolean {
  if (target === "") return false;
  if (ownRoomId !== undefined && ownRoomId !== "" && target === ownRoomId) {
    return false;
  }
  return index.ready && !index.rooms.has(target);
}
