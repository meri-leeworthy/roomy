/**
 * Unit tests for blocks-to-discord.ts
 *
 * Covers rendering Roomy blocks+facets (`space.roomy.richtext.*`) into
 * Discord markdown for the Roomy→Discord bridge direction.
 */

import { describe, expect, test } from "bun:test";
import type { Block, Facet } from "@roomy-space/sdk";
import { blocksToDiscordMarkdown } from "../blocks-to-discord.ts";

function textBlock(text: string, facets?: Facet[]): Block {
	return facets
		? { $type: "space.roomy.richtext.blocks#text", text, facets }
		: { $type: "space.roomy.richtext.blocks#text", text };
}

describe("blocksToDiscordMarkdown", () => {
	test("renders an empty block array to empty string", () => {
		expect(blocksToDiscordMarkdown([])).toBe("");
	});

	test("passes through plain text blocks", () => {
		expect(blocksToDiscordMarkdown([textBlock("Hello, world!")])).toBe(
			"Hello, world!",
		);
	});

	test("joins multiple text blocks with newlines", () => {
		expect(blocksToDiscordMarkdown([textBlock("one"), textBlock("two")])).toBe(
			"one\ntwo",
		);
	});

	describe("inline formatting facets", () => {
		const facetAt = (byteStart: number, byteEnd: number, $type: string) => ({
			index: { byteStart, byteEnd },
			features: [{ $type }],
		});

		test("bold", () => {
			expect(
				blocksToDiscordMarkdown([
					textBlock("say hi now", [
						facetAt(4, 6, "space.roomy.richtext.facet#bold"),
					]),
				]),
			).toBe("say **hi** now");
		});

		test("italic", () => {
			expect(
				blocksToDiscordMarkdown([
					textBlock("an em bit", [
						facetAt(3, 5, "space.roomy.richtext.facet#italic"),
					]),
				]),
			).toBe("an *em* bit");
		});

		test("strikethrough", () => {
			expect(
				blocksToDiscordMarkdown([
					textBlock("gone text", [
						facetAt(0, 4, "space.roomy.richtext.facet#strikethrough"),
					]),
				]),
			).toBe("~~gone~~ text");
		});

		test("inline code", () => {
			expect(
				blocksToDiscordMarkdown([
					textBlock("run ls", [
						facetAt(4, 6, "space.roomy.richtext.facet#code"),
					]),
				]),
			).toBe("run `ls`");
		});

		test("link facet emits the URI (Discord auto-links bare URLs)", () => {
			const linkFacet = {
				index: { byteStart: 0, byteEnd: 4 },
				features: [
					{
						$type: "space.roomy.richtext.facet#link",
						uri: "https://example.com/x",
					},
				],
			};
			expect(blocksToDiscordMarkdown([textBlock("docs", [linkFacet])])).toBe(
				"docs (https://example.com/x)",
			);
		});

		test("link facet whose text is already the URI is not duplicated", () => {
			const linkFacet = {
				index: { byteStart: 0, byteEnd: 22 },
				features: [
					{
						$type: "space.roomy.richtext.facet#link",
						uri: "https://example.com/x",
					},
				],
			};
			expect(
				blocksToDiscordMarkdown([
					textBlock("https://example.com/x", [linkFacet]),
				]),
			).toBe("https://example.com/x");
		});

		test("didMention facet for a bridged Discord user renders <@snowflake>", () => {
			const mention = {
				index: { byteStart: 0, byteEnd: 6 },
				features: [
					{
						$type: "space.roomy.richtext.facet#didMention",
						did: "did:discord:123456789",
					},
				],
			};
			expect(blocksToDiscordMarkdown([textBlock("@Alice", [mention])])).toBe(
				"<@123456789>",
			);
		});

		test("didMention facet for a Roomy-native DID stays as plain text", () => {
			const mention = {
				index: { byteStart: 0, byteEnd: 6 },
				features: [
					{
						$type: "space.roomy.richtext.facet#didMention",
						did: "did:plc:abc123",
					},
				],
			};
			expect(blocksToDiscordMarkdown([textBlock("@Alice", [mention])])).toBe(
				"@Alice",
			);
		});

		test("roomRef facet renders as plain text", () => {
			const roomRef = {
				index: { byteStart: 0, byteEnd: 7 },
				features: [
					{
						$type: "space.roomy.richtext.facet#roomRef",
						spaceId: "did:web:space-a.example",
						roomId: "01JQROOMY1",
					},
				],
			};
			expect(blocksToDiscordMarkdown([textBlock("#general", [roomRef])])).toBe(
				"#general",
			);
		});
	});

	describe("block types", () => {
		test("header renders as bold (no heading support in Discord)", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#header",
						level: 1,
						text: "Title",
					},
				]),
			).toBe("**Title**");
		});

		test("blockquote prefixed with >", () => {
			expect(
				blocksToDiscordMarkdown([
					{ $type: "space.roomy.richtext.blocks#blockquote", text: "quoted" },
				]),
			).toBe("> quoted");
		});

		test("code block with language renders as a fenced code block", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#code",
						text: "const x = 1;",
						language: "ts",
					},
				]),
			).toBe("```ts\nconst x = 1;\n```");
		});

		test("unordered list", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#unorderedList",
						items: [{ text: "one" }, { text: "two" }],
					},
				]),
			).toBe("- one\n- two");
		});

		test("ordered list", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#orderedList",
						items: [{ text: "first" }, { text: "second" }],
					},
				]),
			).toBe("1. first\n2. second");
		});

		test("image emits its uri", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#image",
						uri: "https://x/img.png",
					},
				]),
			).toBe("https://x/img.png");
		});

		test("horizontal rule renders as ---", () => {
			expect(
				blocksToDiscordMarkdown([
					{ $type: "space.roomy.richtext.blocks#horizontalRule" },
				]),
			).toBe("---");
		});

		test("unknown block falls back to its text (open union)", () => {
			expect(
				blocksToDiscordMarkdown([
					{
						$type: "space.roomy.richtext.blocks#futureThing",
						text: "fallback",
					},
				]),
			).toBe("fallback");
		});
	});
});
