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
 */

import { tryOpenGlobalDb } from "../db/db.ts";

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

/** How long a resolved profile (or a miss) is cached before re-querying. */
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, CacheEntry>();

/**
 * Resolve profile display fields for a set of DIDs from the global store.
 * Returns a Map keyed by DID; DIDs with no profile in the global store are
 * absent (callers fall back to whatever they already have).
 */
export async function resolveProfiles(
  dids: string[],
): Promise<Map<string, ProfileFields>> {
  const result = new Map<string, ProfileFields>();
  if (dids.length === 0) return result;

  const now = Date.now();
  const missing: string[] = [];
  for (const did of dids) {
    const cached = cache.get(did);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      if (
        cached.name !== null ||
        cached.handle !== null ||
        cached.avatar !== null
      ) {
        result.set(did, {
          ...(cached.name != null ? { name: cached.name } : {}),
          ...(cached.handle != null ? { handle: cached.handle } : {}),
          ...(cached.avatar != null ? { avatar: cached.avatar } : {}),
        });
      }
    } else {
      missing.push(did);
    }
  }

  if (missing.length > 0) {
    const globalDb = tryOpenGlobalDb();
    if (globalDb) {
      const placeholders = missing.map(() => "?").join(",");
      const rows = await globalDb
        .query(
          `select did, handle, name, avatar from profiles where did in (${placeholders})`,
        )
        .all<{
          did: string;
          handle: string | null;
          name: string | null;
          avatar: string | null;
        }>(...missing);
      for (const row of rows) {
        const fields: ProfileFields = {
          ...(row.name != null ? { name: row.name } : {}),
          ...(row.handle != null ? { handle: row.handle } : {}),
          ...(row.avatar != null ? { avatar: row.avatar } : {}),
        };
        result.set(row.did, fields);
        cache.set(row.did, {
          name: row.name,
          handle: row.handle,
          avatar: row.avatar,
          fetchedAt: now,
        });
      }
      // Cache misses so we don't re-query the global DB on every read.
      for (const did of missing) {
        if (!result.has(did)) {
          cache.set(did, {
            name: null,
            handle: null,
            avatar: null,
            fetchedAt: now,
          });
        }
      }
    }
  }

  return result;
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
): Promise<void> {
  if (items.length === 0) return;
  const profiles = await resolveProfiles(items.map(getDid));
  for (const item of items) {
    const p = profiles.get(getDid(item));
    if (p) apply(item, p);
  }
}

/** Test helper. */
export function _resetProfileStoreCache(): void {
  cache.clear();
}
