import { describe, it, expect } from "vitest";
import {
  proseMirrorDocToBlocks,
  blocksToProseMirrorDoc,
  markdownToBlocks,
  blocksToPlaintext,
} from "./convert";
import type { Block } from "../schema/richtext";

describe("richtext convert — blocks ↔ ProseMirror round-trip", () => {
  it("round-trips a structured doc (header, text, lists) through the editor", () => {
    const blocks: Block[] = [
      { $type: "space.roomy.richtext.blocks#header", text: "Hello", level: 2 },
      { $type: "space.roomy.richtext.blocks#text", text: "Some body text" },
      {
        $type: "space.roomy.richtext.blocks#unorderedList",
        items: [{ text: "a" }, { text: "b" }],
      },
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "1" }, { text: "2" }],
      },
    ];

    const doc = blocksToProseMirrorDoc(blocks);
    expect(doc.type).toBe("doc");
    expect(doc.content?.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
    ]);

    // The editor's own output path must reproduce the same blocks.
    expect(proseMirrorDocToBlocks(doc)).toEqual(blocks);
  });

  it("preserves newlines as hard breaks when re-parsing a soft break", () => {
    // A single newline (soft break) must survive the editor round-trip as a
    // hard break, not collapse to a space.
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line1" },
            { type: "hardBreak" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    expect(blocksToPlaintext(blocks)).toBe("line1 line2");
    // Re-editing: the hard break becomes a paragraph with a hardBreak node.
    const back = blocksToProseMirrorDoc(blocks);
    expect(back.content?.[0]?.content?.[1]?.type).toBe("hardBreak");
  });

  it("markdownToBlocks parses headers and lists", () => {
    const blocks = markdownToBlocks("# Header\n\n- a\n- b\n\n1. one\n2. two");
    expect(blocks.map((b) => b.$type)).toEqual([
      "space.roomy.richtext.blocks#header",
      "space.roomy.richtext.blocks#unorderedList",
      "space.roomy.richtext.blocks#orderedList",
    ]);
  });
});
