/**
 * Which DIDs the `@mention` typeahead may offer, and the recent-activity
 * preseed it derives them from.
 *
 * Two classes of DID reach the typeahead but can never be meaningfully
 * mentioned:
 *
 * - **Bridged Discord users** (`did:discord:<snowflake>`) surface as message
 *   authors through the bridge's `authorOverride` extension, but they are not
 *   ATProto accounts — there is no Roomy user behind the DID to notify and no
 *   profile to render.
 * - **The space itself**, which authors its own system messages ("@alice
 *   joined the space"). It would otherwise be offered under the space's
 *   display name.
 *
 * Both arrive as `getMessages` authors, which is what the empty-query preseed
 * is built from — `space.roomy.space.getMembers` returns neither (it lists
 * `member`/`admin` edges, which only real accounts ever hold).
 *
 * Only real ATProto accounts are mentionable — the same DID rule the appserver
 * uses to decide which DIDs have a resolvable profile (see
 * `packages/appserver/src/materialization/profiles.ts`).
 *
 * Pure and dependency-free on purpose: the composer, the edit-message editor
 * and the forward composer all share this, and it must stay runnable outside
 * a SvelteKit/Vite context.
 */

/** Whether `did` can be offered as an `@mention` in `spaceId`. */
export function isMentionableUser(did: string, spaceId: string): boolean {
  if (did === spaceId) return false;
  return did.startsWith("did:plc:") || did.startsWith("did:web:");
}

/** Drop every unmentionable entry, preserving order. */
export function filterMentionable<T extends { did: string }>(
  users: readonly T[],
  spaceId: string,
): T[] {
  return users.filter((u) => isMentionableUser(u.did, spaceId));
}

/** The `getMessages` fields the preseed reads. */
export interface MentionPreseedMessage {
  authorDid: string;
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string | null;
  /** Canonical timeline order (ULID); falls back to `timestamp`. */
  sort_idx?: string;
  timestamp: string;
}

/** A mentionable user, with the raw avatar reference still unresolved. */
export interface MentionCandidate {
  did: string;
  name?: string;
  handle?: string;
  /** Raw avatar reference (`atblob://…`); the caller resolves it to a URL. */
  avatarUri?: string | null;
}

/**
 * The empty-query preseed: the most-recently-active *mentionable* members of a
 * room, derived from the already-cached `getMessages` result (no extra fetch).
 *
 * Ordered by last activity with the most recent last; capped to `limit`.
 * Filtering happens before the cap so the popover still fills when the tail of
 * the timeline is space-authored system messages.
 */
export function selectRecentMentionableMembers(
  msgs: readonly MentionPreseedMessage[],
  opts: { spaceId: string; selfDid: string | null | undefined; limit?: number },
): MentionCandidate[] {
  const { spaceId, selfDid, limit = 8 } = opts;
  // Track each author's most recent message.
  const lastByDid = new Map<string, { user: MentionCandidate; last: string }>();
  for (const m of msgs) {
    if (m.authorDid === selfDid) continue;
    if (!isMentionableUser(m.authorDid, spaceId)) continue;
    const ord = m.sort_idx ?? m.timestamp;
    const existing = lastByDid.get(m.authorDid);
    if (!existing || ord > existing.last) {
      lastByDid.set(m.authorDid, {
        user: {
          did: m.authorDid,
          name: m.authorName,
          handle: m.authorHandle,
          avatarUri: m.authorAvatar,
        },
        last: ord,
      });
    }
  }
  return [...lastByDid.values()]
    .sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : 0))
    .map((v) => v.user)
    .slice(-limit); // cap to the most-recently-active; most recent stays last
}
