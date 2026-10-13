/**
 * Where a platform's cache is persisted, and what happens when that store is
 * not there.
 *
 * Two things are load-bearing, and asserted here rather than left to
 * inspection:
 *
 *   1. **A shell never uses IndexedDB.** The reason the shell is treated
 *      differently at all is iOS, where the webview's IndexedDB is reported to
 *      misbehave under Tauri. A shell that fell back to IndexedDB would be
 *      falling back to the thing the native store exists to avoid, so its
 *      fallback is `localStorage` — pinned below even with an `indexedDB`
 *      global present.
 *   2. **An absent or failing native store degrades, it does not fail.** No
 *      native store means `localStorage`; a native store that fails its first
 *      read hands the session to `localStorage` (the seam's `withFallback`), and
 *      the restore that triggered it returns an empty cache rather than
 *      throwing.
 *
 * `isShell()` reads `window.__TAURI__`, absent under Vitest's node environment,
 * so every case passes `shell` explicitly — the same fact the shell's own global
 * would supply.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheStorePreference,
  chooseCacheStore,
  choosePersister,
  isShell,
} from "./cache-store";
import type { PersistedEntry, SnapshotPolicy, TauriStoreLike } from "@roomy-space/sdk/browser";

const ACCOUNT = "did:plc:alice";
const KEY = "roomy-query-cache";

function policy(): SnapshotPolicy {
  return { version: "1:build-test", account: ACCOUNT, onDiagnostic: () => {} };
}

function entry(key: string, state: unknown = key): PersistedEntry {
  return { key: [key], state, at: 1 };
}

/** A stand-in for the shell's store; `failing` makes every call reject. */
interface FakeNativeStore extends TauriStoreLike {
  data: Map<string, unknown>;
  failing: boolean;
}

function nativeStore(): FakeNativeStore {
  const data = new Map<string, unknown>();
  const store: FakeNativeStore = {
    data,
    failing: false,
    async get<T>(key: string): Promise<T | undefined> {
      if (store.failing) throw new Error("store unavailable");
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (store.failing) throw new Error("store unavailable");
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      if (store.failing) throw new Error("store unavailable");
      return data.delete(key);
    },
    async save(): Promise<void> {
      if (store.failing) throw new Error("store unavailable");
    },
  };
  return store;
}

/**
 * A working `localStorage`, so the fallback arm is observable under node.
 *
 * The persister reads the global at construction, so installing this before
 * `choosePersister` is what makes the fallback real rather than a no-op. Typed
 * as `Storage` through one named cast: the object implements every method the
 * adaptor calls and nothing else.
 */
function installLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  globalThis.localStorage = storage;
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.localStorage = originalLocalStorage;
  globalThis.indexedDB = originalIndexedDB;
});

const originalLocalStorage = globalThis.localStorage;
const originalIndexedDB = globalThis.indexedDB;

describe("chooseCacheStore — the decision, per platform", () => {
  it("a shell with a native store uses it", () => {
    expect(
      chooseCacheStore({
        shell: true,
        nativeStoreAvailable: true,
        indexedDbAvailable: true,
      }),
    ).toEqual({ kind: "native", reason: "shell" });
  });

  it("a shell without one falls to localStorage, never IndexedDB", () => {
    expect(
      chooseCacheStore({
        shell: true,
        nativeStoreAvailable: false,
        // Present, and still not chosen: the webview's IndexedDB is the reason
        // the shell prefers the native store in the first place.
        indexedDbAvailable: true,
      }),
    ).toEqual({ kind: "localstorage", reason: "shell-without-native-store" });
  });

  it("the web uses IndexedDB", () => {
    expect(
      chooseCacheStore({
        shell: false,
        nativeStoreAvailable: false,
        indexedDbAvailable: true,
      }),
    ).toEqual({ kind: "indexeddb", reason: "web" });
  });

  it("the web without IndexedDB falls to localStorage", () => {
    expect(
      chooseCacheStore({
        shell: false,
        nativeStoreAvailable: false,
        indexedDbAvailable: false,
      }),
    ).toEqual({ kind: "localstorage", reason: "no-indexeddb" });
  });
});

describe("chooseCacheStore — a build's pin", () => {
  it("a build pinning native takes the shell branch without the shell global", () => {
    // The Tauri release build's statement about itself: `VITE_CACHE_STORE`
    // names the store, so the choice does not depend on `__TAURI__` being
    // visible yet.
    expect(
      chooseCacheStore({
        shell: false,
        nativeStoreAvailable: true,
        indexedDbAvailable: true,
        preference: "native",
      }),
    ).toEqual({ kind: "native", reason: "shell" });
  });

  it("a build pinning web never takes the shell branch", () => {
    expect(
      chooseCacheStore({
        shell: true,
        nativeStoreAvailable: true,
        indexedDbAvailable: true,
        preference: "web",
      }),
    ).toEqual({ kind: "indexeddb", reason: "web" });
  });

  it("a pinned store that is not there still degrades, never to IndexedDB", () => {
    // The pin chooses the branch, not the outcome: a shell with no usable store
    // is the `localStorage` case whether it got there by pinning or by probing.
    expect(
      chooseCacheStore({
        shell: false,
        nativeStoreAvailable: false,
        indexedDbAvailable: true,
        preference: "native",
      }),
    ).toEqual({ kind: "localstorage", reason: "shell-without-native-store" });
  });
});

describe("cacheStorePreference — the build's pin", () => {
  it("is auto for anything that is not a store name", () => {
    expect(cacheStorePreference()).toBe("auto");
  });
});

describe("choosePersister — the shell", () => {
  it("round-trips through the native store", async () => {
    installLocalStorage();
    const store = nativeStore();
    const persister = choosePersister({
      policy: policy(),
      nativeStore: store,
      shell: true,
    });

    await persister.save([entry("a", { rows: 1 })]);
    expect(store.data.has(KEY), "written through the native store").toBe(true);

    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["a"]);
    expect(restored[0]?.state).toEqual({ rows: 1 });
  });

  it("a native store that fails its first read hands the session to localStorage", async () => {
    const shared = installLocalStorage();

    // Seed the fallback, which is what makes "the session moved" observable:
    // the load after the failed one reads that snapshot back.
    await choosePersister({
      policy: policy(),
      nativeStore: null,
      shell: true,
    }).save([entry("fallback", "kept")]);
    expect(shared.has(KEY)).toBe(true);

    const store = nativeStore();
    store.failing = true;
    const persister = choosePersister({
      policy: policy(),
      nativeStore: store,
      shell: true,
    });

    // The demotion costs the load that failed, and it is reported rather than
    // thrown — the restore that called it sees an empty cache and fetches.
    await expect(persister.load()).resolves.toEqual([]);
    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["fallback"]);
  });

  it("no native store selects localStorage, even with IndexedDB present", async () => {
    const shared = installLocalStorage();
    // A bare object is enough: the choice only asks whether the platform has
    // the API at all, and the shell must not consult it either way.
    globalThis.indexedDB = {} as IDBFactory;

    const persister = choosePersister({
      policy: policy(),
      nativeStore: null,
      shell: true,
    });

    await persister.save([entry("a")]);
    expect(shared.get(KEY), "written to localStorage, not IndexedDB").toBeTypeOf("string");
    await expect(persister.load()).resolves.toEqual([entry("a")]);
  });
});

describe("choosePersister — the web", () => {
  it("falls to localStorage when the platform has no IndexedDB", async () => {
    const shared = installLocalStorage();

    const persister = choosePersister({ policy: policy(), shell: false });

    await persister.save([entry("a")]);
    expect(shared.get(KEY)).toBeTypeOf("string");
    await expect(persister.load()).resolves.toEqual([entry("a")]);
  });

  it("never reaches for a native store", async () => {
    const shared = installLocalStorage();
    const store = nativeStore();
    const persister = choosePersister({
      policy: policy(),
      shell: false,
      // Present, and ignored: the web build has no shell behind it.
      nativeStore: store,
    });

    await persister.save([entry("a")]);
    expect(store.data.has(KEY)).toBe(false);
    expect(shared.get(KEY)).toBeTypeOf("string");
  });
});

describe("isShell", () => {
  it("is true only when the shell's global is present", () => {
    expect(isShell()).toBe(false);
    vi.stubGlobal("window", { __TAURI__: {} });
    expect(isShell()).toBe(true);
  });
});
