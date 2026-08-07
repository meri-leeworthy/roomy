/**
 * Tests for the rich text converters (`src/richtext/convert.ts`).
 *
 * Covers the Phase 1 acceptance criteria:
 *   - ProseMirror → blocks round-trip (mentions, links, bold/italic/code,
 *     lists, code blocks, internal links) without loss.
 *   - `blocksToPlaintext` matches the legacy `stripMarkdownToPlaintext`
 *     output for the test corpus.
 *   - Facet byte offsets are correct for multi-byte (emoji/CJK) text.
 *   - Wire encoding round-trips through `serializeBlocks`/`deserializeBody`.
 *   - `markdownToBlocks` emits `#link` facets for bare/wrapped URLs.
 */
import { describe, expect, test } from "vitest";
import {
  blocksToPlaintext,
  blocksToProseMirrorDoc,
  deserializeBody,
  extractFacetUrls,
  extractInternalLinkTargets,
  extractMentionDids,
  markdownToBlocks,
  proseMirrorDocToBlocks,
  serializeBlocks,
  type ProseMirrorDoc,
} from "../../src/richtext/convert";

const mentionDoc: ProseMirrorDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hey " },
        {
          type: "text",
          text: "@alice",
          marks: [
            {
              type: "userMention",
              attrs: { id: "did:plc:alice", label: "alice" },
            },
          ],
        },
        { type: "text", text: " check " },
        {
          type: "text",
          text: "this",
          marks: [
            {
              type: "link",
              attrs: { href: "https://roomy.space/did:plc:space/room1" },
            },
          ],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "item one" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("proseMirrorDocToBlocks", () => {
  test("emits didMention and link+roomRef facets with byte offsets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(blocks).toHaveLength(2);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("Hey @alice check this");
    expect(text.facets).toHaveLength(2);
    const mentionFacet = text.facets![0] as {
      index: { byteStart: number; byteEnd: number };
      features: { $type: string; did?: string }[];
    };
    expect(mentionFacet.index).toEqual({ byteStart: 4, byteEnd: 10 });
    expect(mentionFacet.features[0]).toEqual({
      $type: "space.roomy.richtext.facet#didMention",
      did: "did:plc:alice",
    });
    const linkFacet = text.facets![1] as {
      index: { byteStart: number; byteEnd: number };
      features: { $type: string; uri?: string; spaceId?: string; roomId?: string }[];
    };
    expect(linkFacet.index).toEqual({ byteStart: 17, byteEnd: 21 });
    expect(linkFacet.features).toContainEqual({
      $type: "space.roomy.richtext.facet#link",
      uri: "https://roomy.space/did:plc:space/room1",
    });
    expect(linkFacet.features).toContainEqual({
      $type: "space.roomy.richtext.facet#roomRef",
      spaceId: "did:plc:space",
      roomId: "room1",
    });
  });

  test("emits list blocks", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const list = blocks[1] as {
      $type: string;
      items: { text: string }[];
    };
    expect(list.$type).toBe("space.roomy.richtext.blocks#unorderedList");
    expect(list.items).toEqual([{ text: "item one" }]);
  });

  test("emits header, code, blockquote, horizontalRule blocks", () => {
    const doc: ProseMirrorDoc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
          ],
        },
        { type: "horizontalRule" },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    expect(blocks).toEqual([
      {
        $type: "space.roomy.richtext.blocks#header",
        text: "Title",
        level: 2,
      },
      {
        $type: "space.roomy.richtext.blocks#code",
        text: "const x = 1;",
        language: "ts",
      },
      {
        $type: "space.roomy.richtext.blocks#blockquote",
        text: "quoted",
      },
      { $type: "space.roomy.richtext.blocks#horizontalRule" },
    ]);
  });

  test("facet byte offsets are correct for multi-byte text", () => {
    const doc: ProseMirrorDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "héllo " },
            {
              type: "text",
              text: "wörld",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " 🎉" },
          ],
        },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("héllo wörld 🎉");
    const facet = text.facets![0] as {
      index: { byteStart: number; byteEnd: number };
    };
    // "héllo " is 7 bytes (é = 2), "wörld" is 6 bytes (ö = 2).
    expect(facet.index).toEqual({ byteStart: 7, byteEnd: 13 });
  });
});

describe("blocksToProseMirrorDoc", () => {
  test("round-trips the mention doc", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const pm = blocksToProseMirrorDoc(blocks);
    expect(pm.type).toBe("doc");
    expect(pm.content).toHaveLength(2);
    const para = pm.content![0]!;
    expect(para.type).toBe("paragraph");
    const mentionText = para.content!.find(
      (n) => n.marks?.some((m) => m.type === "userMention"),
    );
    expect(mentionText?.text).toBe("@alice");
    expect(mentionText?.marks?.[0]).toEqual({
      type: "userMention",
      attrs: { id: "did:plc:alice" },
    });
  });
});

describe("derivations", () => {
  test("blocksToPlaintext concatenates block text", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(blocksToPlaintext(blocks)).toBe("Hey @alice check this item one");
  });

  test("extractMentionDids collects didMention facets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(extractMentionDids(blocks)).toEqual(["did:plc:alice"]);
  });

  test("extractFacetUrls collects link facet uris", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(extractFacetUrls(blocks)).toEqual([
      "https://roomy.space/did:plc:space/room1",
    ]);
  });

  test("extractInternalLinkTargets collects roomRef facets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(extractInternalLinkTargets(blocks)).toEqual([
      { spaceId: "did:plc:space", roomId: "room1" },
    ]);
  });
});

describe("wire encoding", () => {
  test("serializeBlocks/deserializeBody round-trip", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const wire = serializeBlocks(blocks);
    expect(wire.mimeType).toBe("application/vnd.roomy.richtext+json");
    const back = deserializeBody(wire.mimeType, wire.data);
    expect(back).toEqual(blocks);
  });

  test("deserializeBody returns string for legacy mimeTypes", () => {
    const data = new TextEncoder().encode("**hello**");
    expect(deserializeBody("text/markdown", data)).toBe("**hello**");
  });

  test("deserializeBody returns null for invalid JSON", () => {
    const data = new TextEncoder().encode("{not json");
    expect(deserializeBody("application/vnd.roomy.richtext+json", data)).toBeNull();
  });
});

describe("markdownToBlocks", () => {
  test("parses inline formatting into facets", () => {
    const blocks = markdownToBlocks(
      "**bold** and [link](https://x.com) and `code` and ~~strike~~ and *italic*",
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("bold and link and code and strike and italic");
    const types = (text.facets ?? []).map((f) => {
      const facet = f as { features: { $type: string }[] };
      return facet.features[0]!.$type;
    });
    expect(types).toEqual([
      "space.roomy.richtext.facet#bold",
      "space.roomy.richtext.facet#link",
      "space.roomy.richtext.facet#code",
      "space.roomy.richtext.facet#strikethrough",
      "space.roomy.richtext.facet#italic",
    ]);
  });

  test("emits link facets for markdown links and internal links", () => {
    const blocks = markdownToBlocks(
      "[room](/did:plc:space/room1) and [web](https://example.com)",
    );
    const urls = extractFacetUrls(blocks);
    expect(urls).toEqual(["/did:plc:space/room1", "https://example.com"]);
    const internal = extractInternalLinkTargets(blocks);
    expect(internal).toEqual([{ spaceId: "did:plc:space", roomId: "room1" }]);
  });

  test("parses lists, code fences, headings, blockquotes", () => {
    const blocks = markdownToBlocks(
      [
        "# Title",
        "",
        "> quoted",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
      ].join("\n"),
    );
    const types = blocks.map((b) => b.$type);
    expect(types).toEqual([
      "space.roomy.richtext.blocks#header",
      "space.roomy.richtext.blocks#blockquote",
      "space.roomy.richtext.blocks#code",
      "space.roomy.richtext.blocks#unorderedList",
      "space.roomy.richtext.blocks#orderedList",
    ]);
  });
});
