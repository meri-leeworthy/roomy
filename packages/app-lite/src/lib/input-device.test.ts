/**
 * The bare-Enter rule: an explicit choice wins, otherwise the input device
 * decides. Touch-primary devices have no Shift/Cmd to reach the newline
 * binding with, so their Return inserts a new block; hardware keyboards keep
 * Enter-to-send.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveSendOnEnter } from "./input-device.ts";

describe("resolveSendOnEnter", () => {
  test("sends on a hardware-keyboard device", () => {
    assert.equal(resolveSendOnEnter(undefined, false), true);
  });

  test("inserts a new block on a touch-primary device", () => {
    assert.equal(resolveSendOnEnter(undefined, true), false);
  });

  test("an explicit true still sends on a touch-primary device", () => {
    assert.equal(resolveSendOnEnter(true, true), true);
  });

  test("an explicit false still inserts a new block on a hardware keyboard", () => {
    assert.equal(resolveSendOnEnter(false, false), false);
  });
});
