/**
 * Global profile store read path with an in-memory cache.
 *
 * Per-space DBs keep only stream-scoped profile rows (comp_user/comp_info);
 * a user's profile entity lives in their own stream, so cross-stream
 * authors/members don't resolve from the per-space DB. The authoritative
 * per-user profile lives in the global `profiles` table
 * (data/global.sqlite), written by the profile fetch path
 * (insertProfiles/insertProfilesWithExtras) and the SetUserProfile
 * materialiser.
 *
 * This module resolves profile display fields (name/handle/avatar) for a set
 * of DIDs from the global store, with a short-TTL in-memory cache so the
 * per-space read hot path (getMessages/getMembers/...) doesn't hit the
 * global DB on every message.
 *
 * **Self-healing reads.** The global `profiles` table is the authoritative
 * per-user store, but it is only populated as a side effect of event
 * materialisation and the `getProfile` handler. It can be missing a row for
 * a real user (backfill/fetch failure, a freshly-cleared store, or a user
 * seen for the first time after the backfill that materialised everyone
 * else). Previously this read path silently returned a fallback (the message
 * row's own author fields) for those users — so `getMessages` could omit a
 * profile that the profile page (which hydrates on demand via HappyView then
 * Bluesky) reliably showed.
 *
 * To make reads as reliable as the profile page, DIDs that aren't in the
 * global store are hydrated on demand (HappyView-first, Bluesky fallback) and
 * written back, so a profile never needs to already be present for the read
 * path to return it. A DID that resolves nowhere is not re-fetched on every
 * read — the hydration pipeline's negative cache (materialization/profiles.ts)
 * backs it off after the first failure.
 */

import { tryOpenGlobalDb } from "../db/db.ts";
import type { AsyncDatabase } from "../db/asyncDatabase.ts";
import { getHappyView } from "../happyview.ts";
import {
  PROFILE_REFRESH_TTL_MS,
  getProfilesRoomyFirst,
  insertProfilesWithExtras,
  isProfileFetchBackedOff,
  recordUnresolvedProfiles,
} from "../materialization/profiles.ts";
import type { UserDid } from "@roomy-space/sdk";
import { log } from "../log.ts";

export interface ProfileFields {
  name?: string;
  handle?: string;
  avatar?: string;
}

interface CacheEntry {
  name: string | null;
  handle: string | null;
  avatar: string | null;
  fetchedAt: number;
}

/**
 * How long a *resolved* profile is served from the in-memory cache. A resolved
 * row is authoritative until its TTL, so reads stay off the global DB.
 */
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();

/**
 * Test-only override for on-demand hydration's network fetch. When set,
 * `hydrateMissingProfiles` uses it instead of the HappyView-first / Bluesky
 * pipeline. E2E tests set a no-op stub to keep runs hermetic (no
 * api.bsky.app calls under parallel load).
 */
let testGetProfiles: ((dids: string[]) => Promise<{ did?: string }[]>) | null =
  null;

/** Set a test-only profile fetcher override (or null to clear). */
export function _setTestGetProfiles(
  fn: ((dids: string[]) => Promise<{ did?: string }[]>) | null,
): void {
  testGetProfiles = fn;
}

function entryToFields(entry: CacheEntry): ProfileFields | null {
  // `''` is not a handle: it's what an older revision of the profile write
  // path stored for Roomy-record users (whose records carry no handle). Treat
  // it as absent so consumers fall back to name/did instead of rendering an
  // empty `@`, and so the row is eligible for handle hydration below.
  const handle = entry.handle || null;
  if (entry.name === null && handle === null && entry.avatar === null) {
    return null;
  }
  return {
    ...(entry.name != null ? { name: entry.name } : {}),
    ...(handle != null ? { handle } : {}),
    ...(entry.avatar != null ? { avatar: entry.avatar } : {}),
  };
}

/**
 * Resolve profile display fields for a set of DIDs from the global store.
 * Returns a Map keyed by DID; DIDs with no resolvable profile are absent
 * (callers fall back to whatever they already have).
 *
 * DIDs missing from the global store are hydrated on-demand (HappyView-first,
 * Bluesky fallback) and written back, so the read path self-heals instead of
 * depending on the store already being populated by event materialisation or
 * the profile page.
 */
export async function resolveProfiles(
  dids: string[],
  opts: { allowNetworkFetch?: boolean } = {},
): Promise<Map<string, ProfileFields>> {
  const result = new Map<string, ProfileFields>();
  if (dids.length === 0) return result;

  const now = Date.now();
  const missing: string[] = [];
  for (const did of dids) {
    const cached = cache.get(did);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      const fields = entryToFields(cached);
      if (fields) {
        result.set(did, fields);
      } else {
        // Miss cached by the *global DB read*, not by a fetch: the row can
        // appear at any time (the profile page, materialisation), so re-check
        // the indexed global store rather than serving the miss. The backoff
        // on network fetches is the negative cache's job, not this cache's.
        missing.push(did);
      }
    } else {
      missing.push(did);
    }
  }

  if (missing.length > 0) {
    await resolveFromGlobalDb(missing, result, now, opts.allowNetworkFetch !== false);
  }

  return result;
}

/**
 * Look up a set of DIDs in the global `profiles` table, then — when
 * `allowNetworkFetch` — self-heal any that are still missing via on-demand
 * HappyView-first hydration.
 *
 * `allowNetworkFetch: false` keeps the global-store read (an indexed SQLite
 * lookup) but skips the fetch. Callers on the write path pass it: reading
 * local rows is free, whereas a fetch is a third-party HTTP round-trip
 * parked inside someone's write.
 */
async function resolveFromGlobalDb(
  dids: string[],
  result: Map<string, ProfileFields>,
  now: number,
  allowNetworkFetch: boolean,
): Promise<void> {
  const globalDb = tryOpenGlobalDb();
  // No worker-backed global DB (e.g. a raw in-memory Database in tests) —
  // nothing to read from or hydrate into.
  if (!globalDb) return;

  const stillMissing: string[] = [];
  const placeholders = dids.map(() => "?").join(",");
  const rows = await globalDb
    .query(
      `select did, handle, name, avatar, updated_at from profiles where did in (${placeholders})`,
    )
    .all<{
      did: string;
      handle: string | null;
      name: string | null;
      avatar: string | null;
      updated_at: number;
    }>(...dids);
  for (const row of rows) {
    const entry: CacheEntry = {
      name: row.name,
      handle: row.handle,
      avatar: row.avatar,
      fetchedAt: now,
    };
    cache.set(row.did, entry);
    const fields = entryToFields(entry);
    if (fields) result.set(row.did, fields);
    else stillMissing.push(row.did);
  }

  const notInDb = allowNetworkFetch
    ? dids.filter((d) => !rows.some((r) => r.did === d))
    : [];
  // Rows that exist but carry no usable handle — the `''` an older revision
  // of the profile write path left behind. Hydrate them too, so the row heals
  // rather than being pinned to a handle-less profile forever (the write path
  // treats `''` as absent, so a successful fetch replaces it).
  const handleless = allowNetworkFetch
    ? rows.filter((r) => !r.handle).map((r) => r.did)
    : [];
  // Rows older than the freshness TTL — re-fetch so a display-name/avatar
  // change on the PDS propagates to message/member lists without a visit to
  // the profile page. Mirrors `filterMissing` in materialization/profiles.ts,
  // so the write and read paths refresh a stale row on the same cadence.
  const stale = allowNetworkFetch
    ? rows
        .filter((r) => now - r.updated_at >= PROFILE_REFRESH_TTL_MS)
        .map((r) => r.did)
    : [];
  const toHydrate = [...new Set([...notInDb, ...handleless, ...stale])];
  if (toHydrate.length > 0) {
    // On-demand hydration mirroring the getProfile handler: fetch Roomy
    // records from HappyView (batch) and fall back to Bluesky, then write
    // back to the global store. This is what makes reads as reliable as the
    // profile page even when the store was cleared or never populated — and
    // it is the same pipeline the write path uses, so a DID that resolves
    // nowhere (`getProfilesRoomyFirst` backs it off) is not re-fetched here
    // either.
    await hydrateMissingProfiles(globalDb, toHydrate);
  }

  // Re-read the global store to pick up whatever hydration wrote, and cache
  // the outcome. A DID the fetch left unresolved is remembered by the shared
  // backoff (materialization/profiles.ts), so the next read skips the fetch
  // entirely rather than relying on this cache's TTL.
  const recheck = [...toHydrate, ...stillMissing];
  if (recheck.length > 0) {
    const ph = recheck.map(() => "?").join(",");
    const afterRows = await globalDb
      .query(
        `select did, handle, name, avatar from profiles where did in (${ph})`,
      )
      .all<{
        did: string;
        handle: string | null;
        name: string | null;
        avatar: string | null;
      }>(...recheck);
    for (const row of afterRows) {
      const entry: CacheEntry = {
        name: row.name,
        handle: row.handle,
        avatar: row.avatar,
        fetchedAt: now,
      };
      cache.set(row.did, entry);
      const fields = entryToFields(entry);
      if (fields) result.set(row.did, fields);
    }
    for (const did of recheck) {
      if (!result.has(did)) {
        // No row yet. Cached only to keep the *global DB re-read* cheap; the
        // network backoff is the negative cache's job.
        cache.set(did, { name: null, handle: null, avatar: null, fetchedAt: now });
      }
    }
  }
}

/**
 * On-demand profile hydration for DIDs missing from the global store.
 *
 * Mirrors the `getProfile` handler: query HappyView (batched) for Roomy
 * profile records, fall back to the Bluesky appview, and write whatever is
 * found into the global `profiles` table (idempotent upsert). Failures are
 * swallowed — the caller returns its existing fallback and the DID is backed
 * off, then retried after the negative cache's TTL or by the event
 * materialisation path.
 *
 * The backoff lives in this function rather than inside the pipeline it calls,
 * so it applies identically whether the fetch is the real pipeline or a test
 * stub. `getProfilesRoomyFirst` also consults it, which is what keeps the write
 * path and the read path from retrying each other's failures.
 */
async function hydrateMissingProfiles(
  globalDb: AsyncDatabase,
  dids: string[],
): Promise<void> {
  if (dids.length === 0) return;
  const fetchable = dids.filter((d) => !isProfileFetchBackedOff(d));
  if (fetchable.length === 0) return;
  try {
    if (testGetProfiles) {
      const stubbed = await testGetProfiles(fetchable);
      recordUnresolvedProfiles(
        fetchable,
        new Set(
          stubbed
            .map((p) => p.did)
            .filter((did): did is string => did !== undefined),
        ),
      );
      return;
    }
    const happyView = getHappyView();
    const { profiles, extras } = await getProfilesRoomyFirst(
      fetchable as UserDid[],
      happyView,
    );
    if (profiles.length > 0) {
      await insertProfilesWithExtras(globalDb, profiles, extras);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      `[profileStore] on-demand hydration failed for ${dids.length} DIDs: ${message}`,
    );
  }
}

/**
 * Fill in missing name/handle/avatar on a list of items from the global
 * profile store. `getDid` extracts the DID; `apply` merges resolved fields
 * into the item (global values win over the item's own, which act as a
 * fallback for users the global store doesn't know about).
 */
export async function hydrateProfiles<T>(
  items: T[],
  getDid: (item: T) => string,
  apply: (item: T, fields: ProfileFields) => void,
  opts: { allowNetworkFetch?: boolean } = {},
): Promise<void> {
  if (items.length === 0) return;
  const profiles = await resolveProfiles(items.map(getDid), opts);
  for (const item of items) {
    const p = profiles.get(getDid(item));
    if (p) apply(item, p);
  }
}

/** Test helper. */
export function _resetProfileStoreCache(): void {
  cache.clear();
}
