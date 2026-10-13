/**
 * Tests for tile-address recognition.
 *
 * Run with the package's Node test runner (`node --test`); the module is pure,
 * so no browser stub is needed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseTileAddress } from "./at-uri.ts";

/** Two tiles published on AT, used because they are the addresses that exist. */
const MINESWEEPER = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

describe("parseTileAddress — published tiles", () => {
  test("reads the repo and record key out of a tile address", () => {
    assert.deepEqual(parseTileAddress(MINESWEEPER), {
      did: "did:plc:izttpdp3l6vss5crelt5kcux",
      rkey: "3mcjwwoqjqs2v",
    });
  });

  test("accepts a second address from the same repo", () => {
    assert.deepEqual(parseTileAddress(HELLO), {
      did: "did:plc:izttpdp3l6vss5crelt5kcux",
      rkey: "3meggnybzqs2n",
    });
  });
});

describe("parseTileAddress — not a tile address", () => {
  test("anything that is not an at:// URI", () => {
    for (const value of [
      "",
      HELLO.slice("at://".length),
      "https://example.com/tile",
      "http://did:plc:abc/ing.dasl.masl/3abc",
      "at:/did:plc:abc/ing.dasl.masl/3abc",
      "at:did:plc:abc/ing.dasl.masl/3abc",
    ]) {
      assert.equal(parseTileAddress(value), null, value);
    }
  });

  test("a repository the loader cannot resolve to a PDS", () => {
    assert.equal(
      parseTileAddress("at://did:web:example.com/ing.dasl.masl/3abc"),
      null,
    );
    // A did:plc body is base32 lowercase; a handle is not a DID at all.
    assert.equal(parseTileAddress("at://did:plc:ABCDEF/ing.dasl.masl/3abc"), null);
    assert.equal(parseTileAddress("at://alice.bsky.social/ing.dasl.masl/3abc"), null);
  });

  test("a record in some other collection", () => {
    assert.equal(
      parseTileAddress("at://did:plc:abc/app.bsky.feed.post/3abc"),
      null,
    );
    assert.equal(parseTileAddress("at://did:plc:abc/ing.dasl.masl.app/3abc"), null);
  });

  test("a path that is not exactly repo, collection and key", () => {
    for (const value of [
      "at://did:plc:abc",
      "at://did:plc:abc/",
      "at://did:plc:abc/ing.dasl.masl",
      "at://did:plc:abc/ing.dasl.masl/",
      "at://did:plc:abc/ing.dasl.masl/3abc/",
      "at://did:plc:abc/ing.dasl.masl/3abc/extra",
    ]) {
      assert.equal(parseTileAddress(value), null, value);
    }
  });

  test("a query or fragment, which is not part of a record address", () => {
    assert.equal(parseTileAddress(`${HELLO}?foo=1`), null);
    assert.equal(parseTileAddress(`${HELLO}#top`), null);
  });

  test("a record key outside the allowed character set", () => {
    for (const value of [
      "at://did:plc:abc/ing.dasl.masl/3abc%20x",
      "at://did:plc:abc/ing.dasl.masl/a b",
      "at://did:plc:abc/ing.dasl.masl/3abc$",
    ]) {
      assert.equal(parseTileAddress(value), null, value);
    }
  });
});
