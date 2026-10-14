/**
 * Tests for finding tile addresses in a message body.
 *
 * The failure this defends: an address is prose before it is a record. What
 * arrives in a body has had a full stop, a closing bracket or a quote attached
 * to it by the sentence it sits in, and a markdown body has the target of a
 * link in the facet rather than in the text. A scanner that returns the
 * sentence-punctuated run, or that only reads the text, silently renders no
 * tile for a message that does address one.
 *
 * Written against `node:test` + `node:assert` so the file runs under the
 * package's `node --test` runner.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { findTileAddresses } from "./at-uri.ts";
import {
  MAX_TILES_PER_MESSAGE,
  tileAddressesInBlocks,
  tileAddressesInMarkdown,
} from "./message-tiles.ts";

const MINESWEEPER = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

/** A `#text` block, the shape a typed body carries. */
function text(text: string, facets?: unknown[]): unknown {
  return {
    $type: "space.roomy.richtext.blocks#text",
    text,
    ...(facets ? { facets } : {}),
  };
}

/** A `#link` facet over the whole of a block's text. */
function linkFacet(uri: string): object {
  return {
    index: { byteStart: 0, byteEnd: 1 },
    features: [{ $type: "space.roomy.richtext.facet#link", uri }],
  };
}

describe("findTileAddresses — prose punctuation", () => {
  test("ends at the punctuation a sentence attaches to a bare address", () => {
    for (const [text, expected] of [
      [`see ${MINESWEEPER}.`, [MINESWEEPER]],
      [`(${MINESWEEPER})`, [MINESWEEPER]],
      [`"${MINESWEEPER}"`, [MINESWEEPER]],
      [`${MINESWEEPER}, and it works`, [MINESWEEPER]],
      [`${MINESWEEPER}!`, [MINESWEEPER]],
      [`<${MINESWEEPER}>`, [MINESWEEPER]],
    ] as const) {
      assert.deepEqual(findTileAddresses(text), [...expected], text);
    }
  });

  test("takes back the full stop that is inside a record key's alphabet", () => {
    // The one mark the run cannot end at on its own: `.` is a legal rkey
    // character, so `…/3abc.` lexes as one run.
    assert.deepEqual(findTileAddresses(`posted at ${HELLO}.`), [HELLO]);
    assert.deepEqual(findTileAddresses(`posted at ${HELLO}..`), [HELLO]);
    // A key that really ends in a dot is not a key this can address anyway —
    // the loader's rkey is a TID — so the trim costs nothing.
  });

  test("ends at a query or fragment the address was spelled with", () => {
    // Both are outside the run's alphabet, so the record address is what comes
    // back; neither can be part of a key.
    assert.deepEqual(findTileAddresses(`${HELLO}?foo=1`), [HELLO]);
    assert.deepEqual(findTileAddresses(`${HELLO}#play`), [HELLO]);
  });

  test("keeps the two addresses in one body apart", () => {
    assert.deepEqual(findTileAddresses(`${MINESWEEPER} and ${HELLO}`), [
      MINESWEEPER,
      HELLO,
    ]);
  });

  test("returns each address once", () => {
    assert.deepEqual(findTileAddresses(`${HELLO} ${HELLO}`), [HELLO]);
  });
});

describe("findTileAddresses — what is not a tile", () => {
  test("drops a run that is an address for another collection", () => {
    assert.deepEqual(
      findTileAddresses("at://did:plc:abc/app.bsky.feed.post/3abc"),
      [],
    );
  });

  test("drops a run that is not a record address", () => {
    for (const text of [
      "at://did:plc:abc",
      "at://did:plc:abc/ing.dasl.masl",
      `at://did:plc:abc/ing.dasl.masl/3abc/extra`,
      "at://example.com/ing.dasl.masl/3abc",
    ]) {
      assert.deepEqual(findTileAddresses(text), [], text);
    }
  });

  test("finds nothing in text with no address at all", () => {
    assert.deepEqual(findTileAddresses("https://example.com/a/b", "no at uri"), []);
  });
});

describe("tileAddressesInBlocks", () => {
  test("reads a typed address out of the block text", () => {
    assert.deepEqual(tileAddressesInBlocks([text(`try ${HELLO}`)] as never), [
      HELLO,
    ]);
  });

  test("reads the target of a markdown link, which the text does not carry", () => {
    const blocks = [text("the mine game", [linkFacet(MINESWEEPER)])];
    assert.deepEqual(tileAddressesInBlocks(blocks as never), [MINESWEEPER]);
  });

  test("reads addresses out of a list's items", () => {
    const blocks = [
      {
        $type: "space.roomy.richtext.blocks#unorderedList",
        items: [{ text: HELLO }, { text: MINESWEEPER }],
      },
    ];
    assert.deepEqual(tileAddressesInBlocks(blocks as never), [HELLO, MINESWEEPER]);
  });

  test("skips a code block, where an address is a sample", () => {
    const blocks = [
      { $type: "space.roomy.richtext.blocks#code", text: HELLO },
      text(`and here it is for real: ${HELLO}`),
    ];
    // Found once, from the prose block — not twice, and not from the code.
    assert.deepEqual(tileAddressesInBlocks(blocks as never), [HELLO]);
  });
});

describe("tileAddressesInMarkdown", () => {
  test("reads an address out of a legacy body", () => {
    assert.deepEqual(tileAddressesInMarkdown(`try ${HELLO} out`), [HELLO]);
  });

  test("skips a fenced code block", () => {
    assert.deepEqual(
      tileAddressesInMarkdown("```\n" + HELLO + "\n```\n\nreal: " + HELLO),
      [HELLO],
    );
    assert.deepEqual(
      tileAddressesInMarkdown("~~~\n" + HELLO + "\n~~~"),
      [],
    );
  });

  test("reads a fenced block's own language line as text, not as a fence", () => {
    assert.deepEqual(
      tileAddressesInMarkdown("```" + HELLO + "\n" + HELLO + "\n```"),
      [],
    );
  });
});

describe("MAX_TILES_PER_MESSAGE", () => {
  test("caps the tiles one message renders", () => {
    assert.equal(MAX_TILES_PER_MESSAGE, 4);
  });
});
