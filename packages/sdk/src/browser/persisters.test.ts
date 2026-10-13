/**
 * The storage adaptors, against the four rules of the seam (§3.2).
 *
 * Rule 1 (never throws) is asserted against a store that actively fails — a
 * throwing `localStorage`, a database that cannot open — because the failure
 * it guards is exactly the one that must not reach the app: a quota
 * rejection, a private-mode write refusal, a corrupt store. The other three
 * rules (versioned, account-scoped, bounded) are core's, but an adaptor must
 * not *undo* them: it persists the version it was given, refuses a snapshot
 * written by another, and applies the count budget before writing.
 *
 * `TauriStorePersister` splits rule 1 by direction, and the split is the
 * contract: a failed *read* rejects out of `load` so that `withFallback` can
 * demote the session off a dead store, while a failed *write* is a diagnostic
 * like any other. Both are asserted below.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { persistedShapeVersion } from "../cache/persister";
import type { PersistedEntry, SnapshotPolicy } from "../cache/persister";
import { withFallback } from "../cache/fallback";
import { IndexedDbPersister } from "./indexeddb-persister";
import {
  LocalStoragePersister,
  type StorageLike,
} from "./localstorage-persister";
import {
  TauriStorePersister,
  type TauriStoreLike,
} from "./tauri-store-persister";

const ACCOUNT = "did:plc:alice";
const VERSION = persistedShapeVersion("build-test");
const KEY = "roomy-query-cache";

function policy(
  over: Partial<SnapshotPolicy> = {},
): SnapshotPolicy {
  return {
    version: VERSION,
    account: ACCOUNT,
    onDiagnostic: () => {},
    ...over,
  };
}

const entry = (key: string, state: unknown = key, at = 1): PersistedEntry => ({
  key: [key],
  state,
  at,
});

/** A working `localStorage` (with its backing map exposed for assertions). */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function throwingStorage(error: Error): StorageLike {
  return {
    getItem: () => {
      throw error;
    },
    setItem: () => {
      throw error;
    },
    removeItem: () => {
      throw error;
    },
  };
}

/**
 * A stand-in for the shell's store, with the whole surface exposed for
 * assertions.
 *
 * `failing` makes every call reject, which is the "the store went away"
 * case the persister's read path is shaped around; `saves` counts the
 * explicit `save()` calls, which are what make a write durable before the
 * process exits.
 */
function nativeStore(initial: Record<string, unknown> = {}): TauriStoreLike & {
  data: Map<string, unknown>;
  saves: number;
  failing: boolean;
} {
  const data = new Map(Object.entries(initial));
  const store = {
    data,
    saves: 0,
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
      store.saves += 1;
    },
  };
  return store;
}

// Each test gets a clean IndexedDB universe.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

const adaptors = [
  {
    name: "IndexedDbPersister",
    make: (seen: string[] = []): IndexedDbPersister =>
      new IndexedDbPersister({
        policy: policy({ onDiagnostic: (m) => seen.push(m) }),
        indexedDB: new IDBFactory(),
      }),
    absent: (): IndexedDbPersister =>
      new IndexedDbPersister({ policy: policy(), indexedDB: null }),
  },
  {
    name: "LocalStoragePersister",
    make: (seen: string[] = []): LocalStoragePersister =>
      new LocalStoragePersister({
        policy: policy({ onDiagnostic: (m) => seen.push(m) }),
        storage: memoryStorage(),
      }),
    absent: (): LocalStoragePersister =>
      new LocalStoragePersister({ policy: policy(), storage: null }),
  },
  {
    name: "TauriStorePersister",
    make: (seen: string[] = []): TauriStorePersister =>
      new TauriStorePersister({
        policy: policy({ onDiagnostic: (m) => seen.push(m) }),
        store: nativeStore(),
      }),
    absent: (): TauriStorePersister =>
      new TauriStorePersister({ policy: policy(), store: null }),
  },
];

for (const { name, make, absent } of adaptors) {
  describe(`${name} — the stored snapshot round-trips`, () => {
    it("round-trips a written set", async () => {
      const persister = make();
      await persister.save([entry("a", { rows: 1 }), entry("b", { rows: 2 })]);

      const restored = await persister.load();
      expect(restored.map((e) => e.key[0])).toEqual(["a", "b"]);
      expect(restored[0]?.state).toEqual({ rows: 1 });
    });

    it("returns [] after clear", async () => {
      const persister = make();
      await persister.save([entry("a")]);
      await persister.clear();
      await expect(persister.load()).resolves.toEqual([]);
    });

    it("is a no-op when the platform store is absent", async () => {
      const persister = absent();
      expect(persister.available).toBe(false);
      await expect(persister.save([entry("a")])).resolves.toBeUndefined();
      await expect(persister.load()).resolves.toEqual([]);
    });

    it("loads a never-written key without reporting a corrupt store", async () => {
      const seen: string[] = [];
      const persister = make(seen);

      await expect(persister.load()).resolves.toEqual([]);
      expect(seen).toEqual([]);
    });
  });
}

describe("rule 1 — a storage failure is a diagnostic, never an application error", () => {
  it("LocalStoragePersister.load returns [] when the store throws", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: throwingStorage(new Error("SecurityError")),
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("LocalStoragePersister.save resolves and reports a QuotaExceededError", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: throwingStorage(new Error("QuotaExceededError")),
    });

    await expect(persister.save([entry("a")])).resolves.toBeUndefined();
    expect(seen.some((m) => m.includes("write failed"))).toBe(true);
  });

  it("LocalStoragePersister.load returns [] for corrupt JSON, and reports", async () => {
    const seen: string[] = [];
    const persister = new LocalStoragePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      storage: memoryStorage({ [KEY]: "{not json" }),
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("IndexedDbPersister.load returns [] when the database cannot open", async () => {
    const seen: string[] = [];
    const broken = {
      open: () => {
        throw new Error("IndexedDB disabled");
      },
    } as unknown as IDBFactory;
    const persister = new IndexedDbPersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      indexedDB: broken,
    });

    await expect(persister.load()).resolves.toEqual([]);
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("clear resolves even when the store throws", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: throwingStorage(new Error("nope")),
    });
    await expect(persister.clear()).resolves.toBeUndefined();
  });
});

describe("TauriStorePersister — the shell's store splits rule 1 by direction", () => {
  it("rejects a failed read so withFallback can demote the session", async () => {
    const seen: string[] = [];
    const store = nativeStore();
    const persister = new TauriStorePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      store,
    });

    store.failing = true;

    await expect(persister.load()).rejects.toThrow("store unavailable");
    expect(seen.some((m) => m.includes("read failed"))).toBe(true);
  });

  it("a read failure moves the session onto the fallback store, not into an empty cache", async () => {
    const store = nativeStore();
    const dead = new TauriStorePersister({ policy: policy(), store });
    const fallback = new LocalStoragePersister({
      policy: policy(),
      storage: memoryStorage(),
    });
    await fallback.save([entry("space.roomy.space.getSpaces", "kept")]);

    store.failing = true;
    const wrapped = withFallback(dead, fallback, () => {});

    // The demotion costs one load (the rejection that triggers it), and the
    // next read comes from the store the session is now on.
    await expect(wrapped.load()).resolves.toEqual([]);
    const restored = await wrapped.load();
    expect(restored.map((e) => e.key[0])).toEqual([
      "space.roomy.space.getSpaces",
    ]);
    expect(restored[0]?.state).toBe("kept");
  });

  it("a failed write resolves and reports, so a dead store cannot fail a flush", async () => {
    const seen: string[] = [];
    const store = nativeStore();
    const persister = new TauriStorePersister({
      policy: policy({ onDiagnostic: (m) => seen.push(m) }),
      store,
    });

    store.failing = true;

    await expect(persister.save([entry("a")])).resolves.toBeUndefined();
    expect(seen.some((m) => m.includes("write failed"))).toBe(true);
  });

  it("saves the store explicitly, so a write is on disk before the app exits", async () => {
    const store = nativeStore();
    const persister = new TauriStorePersister({ policy: policy(), store });

    await persister.save([entry("a")]);
    expect(store.saves).toBe(1);

    await persister.clear();
    expect(store.saves).toBe(2);
  });

  it("routes the read through the core rules: a foreign snapshot is refused whole", async () => {
    const store = nativeStore();
    const other = new TauriStorePersister({
      policy: policy({
        version: persistedShapeVersion("build-old"),
        account: "did:plc:bob",
      }),
      store,
    });
    await other.save([entry("a")]);

    // The stored snapshot is another build's and another account's. Both are
    // refused by the same reader the other adaptors use.
    const current = new TauriStorePersister({ policy: policy(), store });
    await expect(current.load()).resolves.toEqual([]);
  });

  it("drops a malformed entry, keeping the rest of the snapshot", async () => {
    const store = nativeStore();
    const writer = new TauriStorePersister({ policy: policy(), store });
    await writer.save([entry("good"), entry("also-good")]);

    // Corrupt one entry in place, the way a truncated or half-written file
    // would arrive: a partial restore is acceptable, a partial entry is not.
    const snapshot = store.data.get(KEY) as { entries: unknown[] };
    snapshot.entries[0] = { key: "not-an-array", state: "x", at: 1 };

    const restored = await writer.load();
    expect(restored.map((e) => e.key[0])).toEqual(["also-good"]);
  });
});

describe("rule 4 — the persisted set is bounded", () => {
  it("keeps the newest entries, dropping the oldest over the count budget", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: memoryStorage(),
      budget: { maxEntries: 2 },
    });

    await persister.save([
      entry("oldest", "keep?", 1),
      entry("middle", "keep", 2),
      entry("newest", "keep", 3),
    ]);

    const restored = await persister.load();
    expect(restored.map((e) => e.key[0])).toEqual(["middle", "newest"]);
  });

  it("localStorage drops oldest-first past the byte cap", async () => {
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage: memoryStorage(),
      // Enough for the envelope and a couple of entries, not all of them.
      maxBytes: 220,
    });

    await persister.save([
      entry("a", "x".repeat(80), 1),
      entry("b", "x".repeat(80), 2),
      entry("c", "x".repeat(80), 3),
    ]);

    const restored = await persister.load();
    expect(restored.length).toBeLessThan(3);
    expect(restored.map((e) => e.key[0])).toContain("c");
    expect(restored.map((e) => e.key[0])).not.toContain("a");
  });

  it("still writes an (empty) snapshot when nothing fits", async () => {
    const storage = memoryStorage();
    const persister = new LocalStoragePersister({
      policy: policy(),
      storage,
      maxBytes: 10,
    });

    await persister.save([entry("a", "x".repeat(100), 1)]);
    await expect(persister.load()).resolves.toEqual([]);
    expect(storage.data.get(KEY)).toBeTypeOf("string");
  });
});

describe("the adaptors do not decide what is persisted", () => {
  it("a snapshot from another build is refused on load, whole", async () => {
    const storage = memoryStorage();
    const stale = new LocalStoragePersister({
      policy: policy({ version: persistedShapeVersion("build-old") }),
      storage,
    });
    await stale.save([entry("a")]);

    const current = new LocalStoragePersister({ policy: policy(), storage });
    await expect(current.load()).resolves.toEqual([]);
  });

  it("a snapshot written for another account is refused", async () => {
    const storage = memoryStorage();
    const bob = new LocalStoragePersister({
      policy: policy({ account: "did:plc:bob" }),
      storage,
    });
    await bob.save([entry("a")]);

    const alice = new LocalStoragePersister({ policy: policy(), storage });
    await expect(alice.load()).resolves.toEqual([]);
  });

  it("writes the snapshot envelope core produces, not entries alone", async () => {
    const storage = memoryStorage();
    const persister = new LocalStoragePersister({ policy: policy(), storage });
    await persister.save([entry("a")]);

    const raw = JSON.parse(storage.data.get(KEY) ?? "null");
    expect(raw.version).toBe(VERSION);
    expect(raw.account).toBe(ACCOUNT);
    expect(raw.savedAt).toBeTypeOf("number");
    expect(raw.entries).toHaveLength(1);
  });
});
