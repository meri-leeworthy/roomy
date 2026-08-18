/**
 * Unit tests for mention-resolver.ts
 *
 * Covers: Discord mention syntax → Roomy blocks+facets transformations.
 * All mention resolution scenarios (user, channel, custom emoji).
 */

import { describe, expect, test } from "bun:test";
import type { Block } from "@roomy-space/sdk";
import {
	type MentionContext,
	resolveMentionsToBlocks,
	type UserMention,
} from "../mention-resolver.ts";

const SPACE = "did:web:space-a.example";

function ctx(overrides: Partial<MentionContext> = {}): MentionContext {
	return {
		channelNames: new Map(),
		roomyRoomIds: new Map(),
		...overrides,
	};
}

/** Extract the text of a block (text-bearing blocks and unknown blocks). */
function blockTextOf(block: Block): string {
	return "text" in block ? (block.text ?? "") : "";
}

/** Extract the plain text of the first (only) block. */
function blockText(
	content: string,
	mentions?: UserMention[],
	c?: MentionContext,
): string {
	const blocks = resolveMentionsToBlocks(content, mentions, c ?? ctx(), SPACE);
	return blocks.map(blockTextOf).join("");
}

/** Collect all facet features across blocks. */
function facetSummary(
	content: string,
	mentions?: UserMention[],
	c?: MentionContext,
) {
	const blocks = resolveMentionsToBlocks(content, mentions, c ?? ctx(), SPACE);
	const text = blocks.map(blockTextOf).join("");
	const didMentions: string[] = [];
	const roomRefs: { spaceId: string; roomId?: string }[] = [];
	const links: string[] = [];
	for (const block of blocks) {
		if (!("facets" in block) || !block.facets) continue;
		for (const f of block.facets) {
			for (const feat of f.features) {
				if (
					feat.$type === "space.roomy.richtext.facet#didMention" &&
					"did" in feat
				) {
					didMentions.push(feat.did);
				} else if (
					feat.$type === "space.roomy.richtext.facet#roomRef" &&
					"spaceId" in feat
				) {
					roomRefs.push({ spaceId: feat.spaceId, roomId: feat.roomId });
				} else if (
					feat.$type === "space.roomy.richtext.facet#link" &&
					"uri" in feat
				) {
					links.push(feat.uri);
				}
			}
		}
	}
	return { text, didMentions, roomRefs, links };
}

describe("resolveMentionsToBlocks", () => {
	test("returns empty array for empty input", () => {
		expect(resolveMentionsToBlocks("", [], ctx(), SPACE)).toEqual([]);
		expect(resolveMentionsToBlocks("", undefined, ctx(), SPACE)).toEqual([]);
	});

	test("produces a plain text block without mentions", () => {
		const blocks = resolveMentionsToBlocks("Hello, world!", [], ctx(), SPACE);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({
			$type: "space.roomy.richtext.blocks#text",
			text: "Hello, world!",
		});
	});

	describe("user mentions", () => {
		test("emits @DisplayName text + didMention facet with did:discord:", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "testuser", globalName: "Test User" },
			];
			const summary = facetSummary("Hey <@12345>!", mentions);
			expect(summary.text).toBe("Hey @Test User!");
			expect(summary.didMentions).toEqual(["did:discord:12345"]);
		});

		test("falls back to username when globalName is absent", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "testuser", globalName: null },
			];
			expect(blockText("<@12345>", mentions)).toBe("@testuser");
		});

		test("handles <@!12345> (nickname format)", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "nickuser", globalName: "Nick User" },
			];
			expect(blockText("<@!12345>", mentions)).toBe("@Nick User");
		});

		test("uses snowflake when user not in mentions array", () => {
			expect(blockText("<@99999>", [])).toBe("@99999");
		});

		test("computes correct UTF-8 byte offsets over the final text", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "test", globalName: "Test User" },
			];
			const blocks = resolveMentionsToBlocks(
				"Hey <@12345>!",
				mentions,
				ctx(),
				SPACE,
			);
			const firstBlock = blocks[0];
			expect(firstBlock).toBeDefined();
			const facets =
				firstBlock && "facets" in firstBlock ? firstBlock.facets : undefined;
			// "Hey " (4 bytes) then "@Test User" (10 bytes)
			expect(facets?.[0]?.index).toEqual({ byteStart: 4, byteEnd: 14 });
		});

		test("offsets are correct with multibyte content before the mention", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "test", globalName: "Alice" },
			];
			const blocks = resolveMentionsToBlocks(
				"hi 👍 <@12345>",
				mentions,
				ctx(),
				SPACE,
			);
			const firstBlock = blocks[0];
			expect(firstBlock).toBeDefined();
			const facets =
				firstBlock && "facets" in firstBlock ? firstBlock.facets : undefined;
			// "hi " = 3 bytes, "👍" = 4 bytes, " " = 1 byte → start at byte 8
			expect(facets?.[0]?.index.byteStart).toBe(8);
			expect(facets?.[0]?.index.byteEnd).toBe(8 + 6); // "@Alice" = 6 bytes
		});
	});

	describe("channel mentions", () => {
		test("emits #name text + roomRef facet when room is mapped", () => {
			const channelNames = new Map([["12345", "general"]]);
			const roomyRoomIds = new Map([["12345", "01JQROOMY1"]]);
			const summary = facetSummary(
				"Check <#12345>",
				[],
				ctx({ channelNames, roomyRoomIds }),
			);
			expect(summary.text).toBe("Check #general");
			expect(summary.roomRefs).toEqual([
				{ spaceId: SPACE, roomId: "01JQROOMY1" },
			]);
			expect(summary.links).toEqual([`/${SPACE}/01JQROOMY1`]);
		});

		test("emits plain #name text when room is not mapped", () => {
			const channelNames = new Map([["12345", "general"]]);
			const summary = facetSummary("Check <#12345>", [], ctx({ channelNames }));
			expect(summary.text).toBe("Check #general");
			expect(summary.roomRefs).toEqual([]);
			expect(summary.links).toEqual([]);
		});

		test("uses snowflake when channel name not in map", () => {
			expect(blockText("<#99999>", [], ctx())).toBe("#99999");
		});
	});

	describe("custom emoji", () => {
		test("strips static custom emoji <:name:id>", () => {
			expect(blockText("Look <:blob:99999>!", [])).toBe("Look !");
		});

		test("strips animated custom emoji <a:name:id>", () => {
			expect(blockText("Look <a:party:88888>!", [])).toBe("Look !");
		});

		test("strips multiple emoji in same message", () => {
			expect(blockText("<:a:111> <:b:222> <a:c:333>", [])).toBe("  ");
		});

		test("preserves Unicode emoji", () => {
			expect(blockText("Hello 👍 world!", [])).toBe("Hello 👍 world!");
		});
	});

	describe("combined scenarios", () => {
		test("handles mixed user, channel, and emoji mentions", () => {
			const mentions: UserMention[] = [
				{ id: BigInt("111"), username: "alice", globalName: "Alice" },
				{ id: BigInt("222"), username: "bob", globalName: null },
			];
			const channelNames = new Map([["333", "general"]]);
			const roomyRoomIds = new Map([["333", "01JQROOMY2"]]);
			const summary = facetSummary(
				"<@111> and <@!222> check <#333> <:wave:444>",
				mentions,
				ctx({ channelNames, roomyRoomIds }),
			);
			expect(summary.text).toBe("@Alice and @bob check #general ");
			expect(summary.didMentions).toEqual([
				"did:discord:111",
				"did:discord:222",
			]);
			expect(summary.roomRefs).toEqual([
				{ spaceId: SPACE, roomId: "01JQROOMY2" },
			]);
		});

		test("handles large content without crashing", () => {
			const largeContent = `${"A".repeat(5000)} <@12345> ${"B".repeat(5000)}`;
			const mentions: UserMention[] = [
				{ id: BigInt("12345"), username: "big", globalName: "Big User" },
			];
			const text = blockText(largeContent, mentions);
			expect(text).toContain("@Big User");
			expect(text.length).toBe(
				largeContent.length - "<@12345>".length + "@Big User".length,
			);
		});
	});
});

// ─── Discord markdown → richtext facets ──────────────────────────────────

/** Extract (text, features[]) pairs with byte ranges for a block's facets. */
function inlineSummary(content: string, mentions?: UserMention[]) {
	const blocks = resolveMentionsToBlocks(content, mentions, ctx(), SPACE);
	const out: {
		type: string;
		text: string;
		marks: { start: number; end: number; features: string[] }[];
	}[] = [];
	for (const block of blocks) {
		const text = blockTextOf(block);
		const marks: { start: number; end: number; features: string[] }[] = [];
		if ("facets" in block && block.facets) {
			for (const f of block.facets) {
				marks.push({
					start: f.index.byteStart,
					end: f.index.byteEnd,
					features: f.features.map((feat) => feat.$type),
				});
			}
		}
		out.push({ type: block.$type, text, marks });
	}
	return out;
}

describe("Discord markdown → richtext", () => {
	test("parses bold **text** into a bold facet", () => {
		const [b] = inlineSummary("hello **world**");
		expect(b?.text).toBe("hello world");
		expect(b?.marks).toEqual([
			{
				start: 6,
				end: 11,
				features: ["space.roomy.richtext.facet#bold"],
			},
		]);
	});

	test("parses italic *text* and _text_ into italic facets", () => {
		const [a] = inlineSummary("a *b* c");
		expect(a?.marks?.[0]).toMatchObject({
			start: 2,
			end: 3,
			features: ["space.roomy.richtext.facet#italic"],
		});
		const [b] = inlineSummary("a _b_ c");
		expect(b?.marks?.[0]).toMatchObject({
			features: ["space.roomy.richtext.facet#italic"],
		});
	});

	test("parses bold+italic ***both*** into two facets", () => {
		const [b] = inlineSummary("***both***");
		expect(b?.text).toBe("both");
		expect(b?.marks?.[0]?.features).toEqual([
			"space.roomy.richtext.facet#bold",
			"space.roomy.richtext.facet#italic",
		]);
	});

	test("parses strikethrough ~~text~~", () => {
		const [b] = inlineSummary("a ~~gone~~ b");
		expect(b?.text).toBe("a gone b");
		expect(b?.marks?.[0]?.features).toEqual([
			"space.roomy.richtext.facet#strikethrough",
		]);
	});

	test("parses underline __text__", () => {
		const [b] = inlineSummary("a __under__ b");
		expect(b?.marks?.[0]?.features).toEqual([
			"space.roomy.richtext.facet#underline",
		]);
	});

	test("parses inline code `code` into a code facet", () => {
		const [b] = inlineSummary("run `npm test` now");
		expect(b?.text).toBe("run npm test now");
		expect(b?.marks?.[0]).toMatchObject({
			start: 4,
			end: 12,
			features: ["space.roomy.richtext.facet#code"],
		});
	});

	test("parses a markdown link [text](url) into a link facet", () => {
		const [b] = inlineSummary("see [docs](https://example.com)");
		expect(b?.text).toBe("see docs");
		expect(b?.marks?.[0]).toMatchObject({
			start: 4,
			end: 8,
			features: ["space.roomy.richtext.facet#link"],
		});
		const linkBlock = resolveMentionsToBlocks(
			"see [docs](https://example.com)",
			[],
			ctx(),
			SPACE,
		)[0];
		const linkFeat =
			linkBlock && "facets" in linkBlock
				? linkBlock.facets?.[0]?.features?.[0]
				: undefined;
		expect(linkFeat).toMatchObject({ uri: "https://example.com" });
	});

	test("parses bold around a Discord mention", () => {
		const mentions: UserMention[] = [
			{ id: BigInt("12345"), username: "u", globalName: "Alice" },
		];
		const [b] = inlineSummary("**<@12345>**", mentions);
		expect(b?.text).toBe("@Alice");
		expect(b?.marks).toEqual([
			{
				start: 0,
				end: 6,
				features: [
					"space.roomy.richtext.facet#bold",
					"space.roomy.richtext.facet#didMention",
				],
			},
		]);
	});

	test("parses a fenced code block into a code block", () => {
		const blocks = resolveMentionsToBlocks(
			"before\n```js\nconst x = 1;\n```\nafter",
			[],
			ctx(),
			SPACE,
		);
		expect(blocks.map((b) => b.$type)).toEqual([
			"space.roomy.richtext.blocks#text",
			"space.roomy.richtext.blocks#code",
			"space.roomy.richtext.blocks#text",
		]);
		const code = blocks[1];
		expect(code && "text" in code ? code.text : undefined).toBe("const x = 1;");
		expect(code && "language" in code ? code.language : undefined).toBe("js");
	});

	test("parses a heading into a header block", () => {
		const blocks = resolveMentionsToBlocks("# Big News", [], ctx(), SPACE);
		const header = blocks[0];
		expect(header?.$type).toBe("space.roomy.richtext.blocks#header");
		expect(header && "text" in header ? header.text : undefined).toBe(
			"Big News",
		);
		expect(header && "level" in header ? header.level : undefined).toBe(1);
	});

	test("parses a blockquote", () => {
		const blocks = resolveMentionsToBlocks("> quoted text", [], ctx(), SPACE);
		expect(blocks[0]?.$type).toBe("space.roomy.richtext.blocks#blockquote");
	});

	test("parses Discord `-# small text` into a small block", () => {
		const blocks = resolveMentionsToBlocks("-# a small caption", [], ctx(), SPACE);
		expect(blocks[0]?.$type).toBe("space.roomy.richtext.blocks#small");
		expect(blocks[0] && "text" in blocks[0] ? blocks[0].text : undefined).toBe(
			"a small caption",
		);
	});

	test("keeps a `-# small text` line as its own block after a paragraph", () => {
		const blocks = resolveMentionsToBlocks(
			"body text\n-# a small caption\nmore body",
			[],
			ctx(),
			SPACE,
		);
		expect(blocks.map((b) => b.$type)).toEqual([
			"space.roomy.richtext.blocks#text",
			"space.roomy.richtext.blocks#small",
			"space.roomy.richtext.blocks#text",
		]);
		expect(blocks[1] && "text" in blocks[1] ? blocks[1].text : undefined).toBe(
			"a small caption",
		);
	});

	test("parses bullet and ordered lists", () => {
		const blocks = resolveMentionsToBlocks(
			"- one\n- two\n\n1. first\n2. second",
			[],
			ctx(),
			SPACE,
		);
		expect(blocks.map((b) => b.$type)).toEqual([
			"space.roomy.richtext.blocks#unorderedList",
			"space.roomy.richtext.blocks#orderedList",
		]);
		const ul = blocks[0];
		const items = ul && "items" in ul ? ul.items : [];
		expect(items.map((i) => i.text)).toEqual(["one", "two"]);
	});

	test("parses a horizontal rule", () => {
		const blocks = resolveMentionsToBlocks("a\n\n---\n\nb", [], ctx(), SPACE);
		expect(blocks.map((b) => b.$type)).toContain(
			"space.roomy.richtext.blocks#horizontalRule",
		);
	});

	test("plain text (no markdown) stays a single plain block", () => {
		const blocks = resolveMentionsToBlocks("just text", [], ctx(), SPACE);
		expect(blocks).toEqual([
			{ $type: "space.roomy.richtext.blocks#text", text: "just text" },
		]);
	});

	test("strips emoji alongside markdown", () => {
		// Emoji contributes no text but surrounding spaces are preserved,
		// matching the legacy mention-stripping behaviour.
		const [b] = inlineSummary("**hi** <:blob:999> there");
		expect(b?.text).toBe("hi  there");
	});

	test("unmatched markdown delimiters are kept as literal text", () => {
		const [b] = inlineSummary("2 * 3 = 6");
		expect(b?.text).toBe("2 * 3 = 6");
		expect(b?.marks).toEqual([]);
	});
});
