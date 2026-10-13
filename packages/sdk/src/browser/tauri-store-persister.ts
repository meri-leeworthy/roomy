/**
 * {@link CachePersister} over a Tauri shell's native key-value store.
 *
 * The shell's store is a JSON file in the app's data directory, reached through
 * the `tauri-plugin-store` plugin. It is the storage path for the desktop, iOS
 * and Android builds, and the iOS *default*: newer iOS versions under Tauri are
 * reported to hit IndexedDB problems, and the shell's store is not subject to
 * the webview's IndexedDB implementation at all.
 *
 * The plugin is not a dependency of this package and is never imported here. A
 * shell loads it (dynamically, so the web build never evaluates it) and passes
 * the store in — the shell is the only thing that can reach the plugin, and the
 * store is the only thing this module needs. Nothing is discovered at runtime:
 * an absent `store` is simply no native store.
 *
 * Values are JSON-shaped already (a snapshot is plain objects, arrays and
 * numbers) and the plugin serialises through JSON in both directions, so there
 * is no structured-clone concern of the kind IndexedDB has.
 *
 * Writes go through the shared persister, so the count budget, the version and
 * account stamps, and rule 1's "a write failure is a diagnostic" all come from
 * there. Reads deliberately do not: a read that fails is the one case where a
 * different store is the answer, and the seam implements that switch exactly
 * once — `withFallback`, which demotes a primary whose `load` rejects. So this
 * adaptor reports the failure and rethrows, and the composition point that
 * wrapped it decides. Where nothing wrapped it, `createCachePersistence`'s
 * restore catches the same rejection and starts cold, which is the behaviour
 * with no persistence at all.
 *
 * Every write is followed by an explicit `save()`. The plugin auto-saves on a
 * debounce, which the seam cannot rely on: the app flushes the cache on
 * `visibilitychange`/`beforeunload`, and a flush whose bytes are still sitting
 * in a debounce when the process goes away has not been persisted.
 */
import {
  readSnapshot,
  type CachePersister,
  type PersistedEntry,
  type SnapshotPolicy,
} from "../cache/persister";
import type { EntryBudget } from "../cache/bound";
import { createSnapshotPersister } from "../cache/storage";

/**
 * The slice of `@tauri-apps/plugin-store`'s `Store` this module calls.
 *
 * Declared structurally rather than imported: this package has no dependency on
 * the plugin, so the web build cannot pull one in through this module.
 */
export interface TauriStoreLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
}

/** The store key. One key holds the whole set: the snapshot *is* the set. */
export const TAURI_STORE_DEFAULT_KEY = "roomy-query-cache";

export interface TauriStorePersisterOptions {
  policy: SnapshotPolicy;
  budget?: EntryBudget;
  /** Key inside the store. Distinct from any other key the shell may keep. */
  key?: string;
  /**
   * The shell's store. Absent when the shell could not open one — the plugin
   * is not registered, the app is not in a shell — in which case every
   * operation is a no-op that {@link TauriStorePersister.available} reports.
   */
  store?: TauriStoreLike | null;
}

export class TauriStorePersister implements CachePersister {
  private readonly store: TauriStoreLike | null;
  private readonly key: string;
  private readonly policy: SnapshotPolicy;
  private readonly persister: CachePersister;

  constructor(opts: TauriStorePersisterOptions) {
    this.store = opts.store ?? null;
    this.key = opts.key ?? TAURI_STORE_DEFAULT_KEY;
    this.policy = opts.policy;

    this.persister = createSnapshotPersister({
      policy: opts.policy,
      budget: opts.budget,
      // Reached by `save`/`clear` only; `load` reads the store itself.
      read: () => this.read(),
      write: (snapshot) => this.write(snapshot),
      remove: () => this.remove(),
    });
  }

  /** True when the shell supplied a native store. */
  get available(): boolean {
    return this.store !== null;
  }

  /**
   * The store hands back a parsed value, so there is no decode step here: a key
   * that was never written is `undefined`, which {@link readSnapshot} treats as
   * an absent snapshot rather than a corrupt one.
   */
  private async read(): Promise<unknown> {
    if (!this.store) return undefined;
    return await this.store.get(this.key);
  }

  private async write(snapshot: unknown): Promise<void> {
    if (!this.store) return;
    await this.store.set(this.key, snapshot);
    await this.store.save();
  }

  private async remove(): Promise<void> {
    if (!this.store) return;
    await this.store.delete(this.key);
    await this.store.save();
  }

  /**
   * Returns no entries when there is no store or no snapshot, and rejects when
   * the store itself fails. See the module comment: the rejection is the signal
   * `withFallback` demotes on, and it is absorbed by the two catch sites on
   * every path into the app (`fallback.ts`, `persistence.ts`).
   */
  async load(): Promise<PersistedEntry[]> {
    if (!this.store) return [];
    try {
      return readSnapshot(await this.store.get(this.key), this.policy);
    } catch (err) {
      this.policy.onDiagnostic?.("cache: persister read failed", err);
      throw err;
    }
  }

  async save(entries: readonly PersistedEntry[]): Promise<void> {
    await this.persister.save(entries);
  }

  async clear(): Promise<void> {
    await this.persister.clear();
  }
}
