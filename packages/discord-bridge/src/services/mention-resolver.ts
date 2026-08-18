/**
 * Resolve Discord message content into Roomy blocks+facets
 * (`space.roomy.richtext.*`).
 *
 * Discord messages carry raw markdown, so this converter parses both the
 * Discord-specific mention/emoji syntax and Discord's CommonMark-subset
 * markdown into Roomy's structured model:
 *
 *   <@!?12345>            → `@DisplayName` text + a `#didMention` facet
 *                           carrying `did:discord:12345`
 *   <#12345>              → `#channel-name` text + `#roomRef`/`#link` facets
 *                           carrying the mapped Roomy room ULID (when bridged)
 *   <:name:id> / <a:name:id> → stripped (custom emoji)
 *   **bold**  *italic*  _italic_  ~~strike~~  __underline__  `code`
 *   [text](url)           → inline facets over the rendered text
 *   # heading, > quote, ``` fence ```, - / 1. lists, --- → block elements
 *
 * Display names are substituted into the text so Discord→Roomy messages show
 * readable names; the facet carries the semantic DID/room reference. Facet
 * indices are UTF-8 byte offsets over the final text.
 *
 * Both `channelNames` and `roomyRoomIds` are pre-resolved maps
 * (snowflake → name / roomy ULID). The caller is responsible for resolving
 * them before calling this function (e.g. via REST API fallback on cache
 * miss).
 */

import {
	type Block,
	type Facet,
	type FacetFeature,
	utf8ByteLength,
} from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";

const log = createLogger("mention-resolver");

/** Minimal user mention data needed for display name resolution. */
export interface UserMention {
	id: bigint | string;
	username: string;
	globalName?: string | null;
}

export interface MentionContext {
	/** Snowflake → display name for Discord channels. */
	channelNames: Map<string, string>;
	/** Snowflake → Roomy room ULID (per-space). */
	roomyRoomIds: Map<string, string>;
}

/** One run of contiguous text with the facets that annotate it. */
interface Segment {
	text: string;
	features: FacetFeature[];
}

/** Everything the inline parser needs to resolve mentions/emoji. */
interface InlineCtx {
	userMap: Map<string, string>;
	channelNames: Map<string, string>;
	roomyRoomIds: Map<string, string>;
	spaceDid: string;
}

// ─── Block builders (typed so no `as` assertions are needed) ────────────

function textBlock(text: string, facets?: Facet[]): Block {
	const base = { $type: "space.roomy.richtext.blocks#text" as const, text };
	return facets && facets.length > 0 ? { ...base, facets } : base;
}

function headerBlock(text: string, level: number, facets?: Facet[]): Block {
	const base = {
		$type: "space.roomy.richtext.blocks#header" as const,
		text,
		level,
	};
	return facets && facets.length > 0 ? { ...base, facets } : base;
}

function blockquoteBlock(
	text: string,
	facets?: Facet[],
	level?: number,
): Block {
	const base = {
		$type: "space.roomy.richtext.blocks#blockquote" as const,
		text,
		...(level && level > 1 ? { level } : {}),
	};
	return facets && facets.length > 0 ? { ...base, facets } : base;
}

function smallBlock(text: string, facets?: Facet[]): Block {
	const base = {
		$type: "space.roomy.richtext.blocks#small" as const,
		text,
	};
	return facets && facets.length > 0 ? { ...base, facets } : base;
}

function codeBlock(text: string, language?: string): Block {
	return language
		? { $type: "space.roomy.richtext.blocks#code" as const, text, language }
		: { $type: "space.roomy.richtext.blocks#code" as const, text };
}

function listItem(
	text: string,
	facets?: Facet[],
): { text: string; facets?: Facet[] } {
	return facets && facets.length > 0 ? { text, facets } : { text };
}

function imageBlock(uri: string, alt?: string): Block {
	return alt
		? { $type: "space.roomy.richtext.blocks#image" as const, uri, alt }
		: { $type: "space.roomy.richtext.blocks#image" as const, uri };
}

/**
 * Resolve Discord markdown + mention syntax in message content into Roomy
 * blocks with `#bold`/`#italic`/`#code`/`#strikethrough`/`#underline`/
 * `#link`/`#didMention`/`#roomRef` facets.
 *
 * @param content - Raw message content from Discord.
 * @param mentions - Parsed Discord mention objects (from msg.mentions).
 * @param ctx - Pre-resolved channel names and roomy room IDs.
 * @param spaceDid - The target space, used to build `#roomRef` spaceId.
 * @returns Blocks (or an empty array for empty content).
 */
export function resolveMentionsToBlocks(
	content: string,
	mentions: UserMention[] | undefined,
	ctx: MentionContext,
	spaceDid: string,
): Block[] {
	if (!content) return [];

	const userMap = new Map<string, string>();
	for (const u of mentions || []) {
		const displayName = u.globalName || u.username;
		userMap.set(u.id.toString(), displayName);
	}

	const inlineCtx: InlineCtx = {
		userMap,
		channelNames: ctx.channelNames,
		roomyRoomIds: ctx.roomyRoomIds,
		spaceDid,
	};

	const blocks = parseBlocks(content, inlineCtx);
	log.debug(
		`Resolved Discord content (${content.length} chars) → ${blocks.length} block(s)`,
	);
	return blocks;
}

// ─── Block-level parsing ────────────────────────────────────────────────

/** Parse a multi-line Discord message into Roomy blocks. */
function parseBlocks(content: string, ctx: InlineCtx): Block[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;

	const inlineFacets = (text: string): { text: string; facets: Facet[] } =>
		parseInlineToText(text, ctx);

	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		const trimmed = line.trim();

		if (trimmed === "") {
			i++;
			continue;
		}

		// Fenced code block.
		const fence = /^```(\w*)/.exec(trimmed);
		if (fence) {
			const language = fence[1] && fence[1].length > 0 ? fence[1] : undefined;
			const codeLines: string[] = [];
			i++;
			while (i < lines.length) {
				const ln = lines[i];
				if (ln === undefined || /^```/.test(ln.trim())) break;
				codeLines.push(ln);
				i++;
			}
			i++; // closing fence
			blocks.push(codeBlock(codeLines.join("\n"), language));
			continue;
		}

		// Horizontal rule.
		if (/^[-*_]{3,}\s*$/.test(trimmed)) {
			blocks.push({
				$type: "space.roomy.richtext.blocks#horizontalRule" as const,
			});
			i++;
			continue;
		}

		// Heading.
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			const content = heading[2] ?? "";
			const level = heading[1]?.length ?? 1;
			const { text, facets } = inlineFacets(content);
			blocks.push(headerBlock(text, level, facets));
			i++;
			continue;
		}

		// Small text (Discord `-# small text`).
		const small = /^-#\s+(.*)$/.exec(trimmed);
		if (small) {
			const content = small[1] ?? "";
			const { text, facets } = inlineFacets(content);
			blocks.push(smallBlock(text, facets));
			i++;
			continue;
		}

		// Blockquote. Discord supports `> ` (single-line), `>> ` (nested), and
		// `>>> ` (multi-line: everything until a blank line is quoted).
		if (trimmed.startsWith(">")) {
			// Multi-line blockquote: `>>> text` quotes the rest of this line
			// and every following line until a blank line.
			if (/^>>>/.test(trimmed)) {
				const quoteLines: string[] = [trimmed.replace(/^>>>\s?/, "")];
				i++;
				while (i < lines.length) {
					const ln = lines[i];
					if (ln === undefined || ln.trim() === "") break;
					quoteLines.push(ln.trim());
					i++;
				}
				const { text, facets } = inlineFacets(quoteLines.join(" "));
				blocks.push(blockquoteBlock(text, facets));
				continue;
			}

			// Single-line / nested: group consecutive `>`-prefixed lines by
			// their nesting depth (number of leading `>`), emitting one
			// blockquote block per level so nesting is preserved.
			while (i < lines.length) {
				const ln = lines[i];
				if (ln === undefined || !ln.trim().startsWith(">")) break;
				const t = ln.trim();
				const level = (t.match(/^>+/) ?? [""])[0]?.length ?? 1;
				const quoteLines: string[] = [t.replace(/^>+\s?/, "")];
				i++;
				while (i < lines.length) {
					const nxt = lines[i];
					if (nxt === undefined) break;
					const nt = nxt.trim();
					if (
						!nt.startsWith(">") ||
						(nt.match(/^>+/) ?? [""])[0]?.length !== level
					) {
						break;
					}
					quoteLines.push(nt.replace(/^>+\s?/, ""));
					i++;
				}
				const { text, facets } = inlineFacets(quoteLines.join(" "));
				blocks.push(blockquoteBlock(text, facets, level));
			}
			continue;
		}

		// Bullet list.
		const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
		if (bullet) {
			const items: { text: string; facets?: Facet[] }[] = [];
			while (i < lines.length) {
				const ln = lines[i];
				if (ln === undefined) break;
				const m = /^([-*+])\s+(.*)$/.exec(ln.trim());
				if (!m) break;
				const itemText = m[2] ?? "";
				const { text, facets } = inlineFacets(itemText);
				items.push(listItem(text, facets));
				i++;
			}
			blocks.push({
				$type: "space.roomy.richtext.blocks#unorderedList" as const,
				items,
			});
			continue;
		}

		// Ordered list.
		const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			const items: { text: string; facets?: Facet[] }[] = [];
			while (i < lines.length) {
				const ln = lines[i];
				if (ln === undefined) break;
				const m = /^(\d+)[.)]\s+(.*)$/.exec(ln.trim());
				if (!m) break;
				const itemText = m[2] ?? "";
				const { text, facets } = inlineFacets(itemText);
				items.push(listItem(text, facets));
				i++;
			}
			blocks.push({
				$type: "space.roomy.richtext.blocks#orderedList" as const,
				items,
			});
			continue;
		}

		// Image on its own line.
		const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed);
		if (image) {
			const uri = image[2];
			if (uri) blocks.push(imageBlock(uri, image[1] ?? undefined));
			i++;
			continue;
		}

		// Paragraph: consume until a blank line or a block-level construct.
		const paraLines: string[] = [trimmed];
		i++;
		while (i < lines.length) {
			const ln = lines[i];
			if (ln === undefined) break;
			const t = ln.trim();
			if (
				t === "" ||
				/^(#{1,6})\s+/.test(t) ||
				/^-\#\s+/.test(t) ||
				/^```/.test(t) ||
				/^>/.test(t) ||
				/^([-*+])\s+/.test(t) ||
				/^(\d+)[.)]\s+/.test(t) ||
				/^[-*_]{3,}\s*$/.test(t)
			) {
				break;
			}
			paraLines.push(t);
			i++;
		}
		// Join consecutive lines with a newline (not a space) so Discord's
		// single-line breaks survive the bridge — multiple lines must not
		// collapse into one.
		const { text, facets } = inlineFacets(paraLines.join("\n"));
		blocks.push(textBlock(text, facets));
	}

	return blocks;
}

// ─── Inline parsing ─────────────────────────────────────────────────────

/**
 * Parse inline Discord markdown + mentions into plain text + facets.
 * Facet byte offsets are computed over the final plain text.
 */
function parseInlineToText(
	input: string,
	ctx: InlineCtx,
): { text: string; facets: Facet[] } {
	const segments = parseInline(input, ctx, []);
	const text = segments.map((s) => s.text).join("");
	const facets: Facet[] = [];
	let byte = 0;
	for (const seg of segments) {
		if (seg.features.length > 0 && seg.text.length > 0) {
			facets.push({
				index: {
					byteStart: byte,
					byteEnd: byte + utf8ByteLength(seg.text),
				},
				features: seg.features,
			});
		}
		byte += utf8ByteLength(seg.text);
	}
	return { text, facets };
}

/**
 * Recursively tokenize inline content into text runs, each annotated with the
 * set of facet features active over it. Nested marks are supported: the inner
 * content of a mark is parsed with the mark's feature inherited, so e.g.
 * `**<@12345>**` yields a run carrying both `#bold` and `#didMention`.
 */
function parseInline(
	input: string,
	ctx: InlineCtx,
	inherited: FacetFeature[],
): Segment[] {
	const segments: Segment[] = [];
	let plain = "";
	const flush = () => {
		if (plain) {
			segments.push({ text: plain, features: inherited });
			plain = "";
		}
	};

	let i = 0;
	while (i < input.length) {
		const rest = input.slice(i);

		// Custom emoji → stripped (contributes no text).
		const emoji = /^<a?:(\w+):(\d+)>/.exec(rest);
		if (emoji) {
			flush();
			i += emoji[0].length;
			continue;
		}

		// User mention <@12345> / <@!12345>.
		const userM = /^<@!?(\d+)>/.exec(rest);
		if (userM) {
			flush();
			const snowflake = userM[1] ?? "";
			const name = ctx.userMap.get(snowflake) ?? snowflake;
			segments.push({
				text: `@${name}`,
				features: [
					...inherited,
					{
						$type: "space.roomy.richtext.facet#didMention" as const,
						did: `did:discord:${snowflake}`,
					},
				],
			});
			i += userM[0].length;
			continue;
		}

		// Channel mention <#12345>.
		const chM = /^<#(\d+)>/.exec(rest);
		if (chM) {
			flush();
			const snowflake = chM[1] ?? "";
			const displayName = ctx.channelNames.get(snowflake) ?? snowflake;
			const features: FacetFeature[] = [...inherited];
			const roomyRoomId = ctx.roomyRoomIds.get(snowflake);
			if (roomyRoomId) {
				features.push(
					{
						$type: "space.roomy.richtext.facet#roomRef" as const,
						spaceId: ctx.spaceDid,
						roomId: roomyRoomId,
					},
					{
						$type: "space.roomy.richtext.facet#link" as const,
						uri: `/${ctx.spaceDid}/${roomyRoomId}`,
					},
				);
			}
			segments.push({ text: `#${displayName}`, features });
			i += chM[0].length;
			continue;
		}

		// Markdown link [text](url).
		const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
		if (link) {
			flush();
			const href = link[2] ?? "";
			segments.push(
				...parseInline(link[1] ?? "", ctx, [
					...inherited,
					{ $type: "space.roomy.richtext.facet#link" as const, uri: href },
				]),
			);
			i += link[0].length;
			continue;
		}

		// Bare URL (Discord auto-links these). Turn it into a link facet so the
		// URL is clickable on the Roomy side too.
		const bareUrl = /^https?:\/\/[^\s<>()]+/.exec(rest);
		if (bareUrl) {
			flush();
			const url = bareUrl[0] ?? "";
			segments.push({
				text: url,
				features: [
					...inherited,
					{ $type: "space.roomy.richtext.facet#link" as const, uri: url },
				],
			});
			i += url.length;
			continue;
		}

		// Inline code `code`.
		const code = /^`([^`]+)`/.exec(rest);
		if (code) {
			flush();
			segments.push({
				text: code[1] ?? "",
				features: [
					...inherited,
					{ $type: "space.roomy.richtext.facet#code" as const },
				],
			});
			i += code[0].length;
			continue;
		}

		// Bold + italic ***...*** (check before ** and *).
		if (rest.startsWith("***")) {
			const end = rest.indexOf("***", 3);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(3, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#bold" as const },
						{ $type: "space.roomy.richtext.facet#italic" as const },
					]),
				);
				i += end + 3;
				continue;
			}
		}

		// Bold **...**.
		if (rest.startsWith("**")) {
			const end = rest.indexOf("**", 2);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(2, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#bold" as const },
					]),
				);
				i += end + 2;
				continue;
			}
		}

		// Strikethrough ~~...~~.
		if (rest.startsWith("~~")) {
			const end = rest.indexOf("~~", 2);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(2, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#strikethrough" as const },
					]),
				);
				i += end + 2;
				continue;
			}
		}

		// Underline __...__ (check before _).
		if (rest.startsWith("__")) {
			const end = rest.indexOf("__", 2);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(2, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#underline" as const },
					]),
				);
				i += end + 2;
				continue;
			}
		}

		// Italic *...* (single asterisk).
		if (rest.startsWith("*") && !rest.startsWith("**")) {
			const end = rest.indexOf("*", 1);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(1, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#italic" as const },
					]),
				);
				i += end + 1;
				continue;
			}
		}

		// Italic _..._ (single underscore).
		if (rest.startsWith("_") && !rest.startsWith("__")) {
			const end = rest.indexOf("_", 1);
			if (end !== -1) {
				flush();
				segments.push(
					...parseInline(rest.slice(1, end), ctx, [
						...inherited,
						{ $type: "space.roomy.richtext.facet#italic" as const },
					]),
				);
				i += end + 1;
				continue;
			}
		}

		// Plain character.
		plain += input[i] ?? "";
		i++;
	}
	flush();
	return segments;
}
