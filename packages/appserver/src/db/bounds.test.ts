import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_SPACE_DBS,
  DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
  DEFAULT_SPACE_DB_CACHE_KIB,
  SPACE_DB_CONNECTION_OVERHEAD_KIB,
  dbMemoryBoundsFromEnv,
  spaceDbConnectionCountForBudget,
} from "./bounds.ts";

/** The env vars `dbMemoryBoundsFromEnv` reads, restored after each test. */
const ENV_KEYS = [
  "APPSERVER_MAX_SPACE_DBS",
  "APPSERVER_MAX_PREPARED_STMTS",
  "APPSERVER_SPACE_DB_CACHE_KIB",
  "APPSERVER_SPACE_DB_CACHE_BUDGET_KIB",
] as const;

const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Process-wide ceiling the connection cache must fit. The measured process
 * base (main heap, 11 worker heaps, runtime) is ~350 MiB, so 400 MiB of
 * connections keeps RSS under the 1 GiB the host alerts at.
 */
const PROCESS_CONNECTION_BUDGET_KIB = 400 * 1024;

/** `DEFAULT_POOL_SIZE` in `db.ts`: per-space workers in a default pool. */
const POOL_SIZE = 8;

/** Price a connection count the way the budget does: page cache + fixed cost. */
const priceKib = (count: number, cacheKib: number) =>
  count * (cacheKib + SPACE_DB_CONNECTION_OVERHEAD_KIB);

describe("per-space connection cache is bounded on the byte axis", () => {
  test("the default count's resident cost fits the default budget", () => {
    // The bound that matters is bytes, not connections: a connection costs its
    // page cache plus SPACE_DB_CONNECTION_OVERHEAD_KIB, and the count-only
    // default this replaced (100) priced the cache at 118 MiB per worker while
    // claiming 50 MiB.
    expect(priceKib(DEFAULT_MAX_SPACE_DBS, DEFAULT_SPACE_DB_CACHE_KIB)).toBeLessThanOrEqual(
      DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
    );
    expect(DEFAULT_MAX_SPACE_DBS).toBeGreaterThan(1);
  });

  test("the default pool fits the process-wide connection budget", () => {
    // Independent of the budget knob the count derives from: this is the
    // requirement. A count-only default of 100 connections per worker prices
    // to 950 MiB across eight workers, over twice this ceiling.
    expect(
      priceKib(DEFAULT_MAX_SPACE_DBS, DEFAULT_SPACE_DB_CACHE_KIB) * POOL_SIZE,
    ).toBeLessThanOrEqual(PROCESS_CONNECTION_BUDGET_KIB);
  });

  test("the environment default obeys the budget", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const bounds = dbMemoryBoundsFromEnv();
    expect(priceKib(bounds.maxSpaceDbs, bounds.spaceDbCacheKib)).toBeLessThanOrEqual(
      DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
    );
  });

  test("a larger page cache buys fewer connections", () => {
    const small = spaceDbConnectionCountForBudget(DEFAULT_SPACE_DB_CACHE_BUDGET_KIB, 512);
    const large = spaceDbConnectionCountForBudget(DEFAULT_SPACE_DB_CACHE_BUDGET_KIB, 4096);
    expect(large).toBeLessThan(small);
    // Both fit the same budget: the count is what moved.
    expect(priceKib(large, 4096)).toBeLessThanOrEqual(DEFAULT_SPACE_DB_CACHE_BUDGET_KIB);
  });

  test("the budget scales the count", () => {
    const half = spaceDbConnectionCountForBudget(DEFAULT_SPACE_DB_CACHE_BUDGET_KIB / 2, 512);
    const full = spaceDbConnectionCountForBudget(DEFAULT_SPACE_DB_CACHE_BUDGET_KIB, 512);
    expect(half).toBeLessThan(full);
  });

  test("the env page-cache knob moves the derived count, not just the cache", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const base = dbMemoryBoundsFromEnv();
    process.env.APPSERVER_SPACE_DB_CACHE_KIB = "4096";
    const wider = dbMemoryBoundsFromEnv();
    expect(wider.maxSpaceDbs).toBeLessThan(base.maxSpaceDbs);
    expect(priceKib(wider.maxSpaceDbs, wider.spaceDbCacheKib)).toBeLessThanOrEqual(
      DEFAULT_SPACE_DB_CACHE_BUDGET_KIB,
    );
  });

  test("an explicit connection count still wins", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.APPSERVER_MAX_SPACE_DBS = "7";
    expect(dbMemoryBoundsFromEnv().maxSpaceDbs).toBe(7);
  });

  test("the count never falls below one", () => {
    expect(spaceDbConnectionCountForBudget(1, 512)).toBe(1);
    expect(spaceDbConnectionCountForBudget(0, 512)).toBe(1);
  });
});
