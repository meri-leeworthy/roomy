/**
 * Freshness gate (TASK-151).
 *
 * Regression cover for the 2026-09-16 push flood: a replay of historical
 * messages (Discord bridge `runBackfill`) ingests old messages with fresh
 * event ULIDs, and the push pipeline had no age check anywhere — so every
 * replayed message produced a live push.
 *
 * Pre-fix, the code these tests cover did not exist: the enqueue site passed
 * only `decodeTime(event.id)` (always "now") and nothing consulted it. The
 * boundary test below is the one that fails on the pre-fix behaviour, where
 * every message was treated as fresh.
 */

import { describe, expect, test } from "bun:test";
import { ulid } from "ulidx";
import { isPushFresh, PUSH_MAX_MESSAGE_AGE_MS } from "./freshness.ts";

const NOW = 1_800_000_000_000; // fixed clock
const freshId = ulid(NOW - 1_000); // ingested 1s ago
const oldId = ulid(NOW - 6 * 60 * 60 * 1000); // ingested 6h ago

describe("push/freshness — isPushFresh", () => {
  test("live message (canonical time ~now) is fresh", () => {
    expect(isPushFresh({ canonicalTimestamp: NOW - 2_000, messageId: freshId }, NOW)).toBe(true);
  });

  test("historical message replayed now is NOT fresh (the flood)", () => {
    // The 2026-09-16 shape: a day-old message, ingested this instant. The
    // event ULID is fresh; only the canonical time reveals the message is old.
    const dayOld = NOW - 24 * 60 * 60 * 1000;
    expect(isPushFresh({ canonicalTimestamp: dayOld, messageId: freshId }, NOW)).toBe(false);
  });

  test("boundary: exactly at the window is fresh, one ms past is not", () => {
    expect(isPushFresh({ canonicalTimestamp: NOW - PUSH_MAX_MESSAGE_AGE_MS, messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ canonicalTimestamp: NOW - PUSH_MAX_MESSAGE_AGE_MS - 1, messageId: freshId }, NOW)).toBe(false);
  });

  test("falls back to the ULID time when canonicalTimestamp is absent", () => {
    // No override (native messages): the event ULID time IS the message time.
    expect(isPushFresh({ messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ messageId: oldId }, NOW)).toBe(false);
  });

  test("undecodable message id is treated as fresh, never dropped", () => {
    // The gate is an age check. "Age unknown" must not silently swallow a
    // live notification — that is the opposite failure, and a worse one.
    expect(isPushFresh({ messageId: "not-a-ulid" }, NOW)).toBe(true);
  });

  test("timestamp far in the future is not treated as live", () => {
    const ahead = NOW + 60 * 60 * 1000;
    expect(isPushFresh({ canonicalTimestamp: ahead, messageId: freshId }, NOW)).toBe(false);
  });

  test("non-finite canonicalTimestamp falls back to the ULID time", () => {
    expect(isPushFresh({ canonicalTimestamp: Number.NaN, messageId: freshId }, NOW)).toBe(true);
    expect(isPushFresh({ canonicalTimestamp: Number.NaN, messageId: oldId }, NOW)).toBe(false);
  });
});
