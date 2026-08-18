/**
 * Convert Roomy blocks+facets (`space.roomy.richtext.*`) into Discord
 * markdown for the Roomy→Discord direction of the bridge.
 *
 * Discord's message markdown is a subset of CommonMark: it supports bold,
 * italic, strikethrough, inline code, fenced code blocks, blockquotes, lists,
 * horizontal rules, and bare-URL auto-linking (but not `[text](url)` inline
 * links — those render literally, so link facets are emitted as the URI text,
 * which Discord auto-links).
 *
 * Facet indices are UTF-8 byte offsets into the block `text`. This module
 * centralises the byte→UTF-16 conversion needed to slice JS strings.
 */

import type { Block, Facet, FacetFeature } from "@roomy-space/sdk";

/** Convert a UTF-8 byte offset into a JS string to a UTF-16 code-unit index. */
function utf8ToUtf16(s: string, byteOffset: number): number {
	const bytes = new TextEncoder().encode(s);
	if (byteOffset <= 0) return 0;
	if (byteOffset >= bytes.length) return s.length;
	let bytePos = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		bytePos += c >= 0x800 ? 3 : c >= 0x80 ? 2 : 1;
		if (bytePos >= byteOffset) return i + 1;
	}
	return s.length;
}

/**
 * Render one inline segment, wrapping it in Discord markdown for the facet
 * features that cover it. Plain text is passed through unescaped to match the
 * legacy bridge behaviour (Roomy markdown is largely Discord-compatible).
 */
function applyFeatures(segment: string, features: FacetFeature[]): string {
	let out = segment;
	for (const f of features) {
		switch (f.$type) {
			case "space.roomy.richtext.facet#bold":
				out = `**${out}**`;
				break;
			case "space.roomy.richtext.facet#italic":
				out = `*${out}*`;
				break;
			case "space.roomy.richtext.facet#underline":
				out = `__${out}__`;
				break;
			case "space.roomy.richtext.facet#strikethrough":
				out = `~~${out}~~`;
				break;
			case "space.roomy.richtext.facet#code":
				out = `\`${out}\``;
				break;
			case "space.roomy.richtext.facet#link":
				// Discord auto-links bare URLs. If the link text is already the
				// URI, emit it as-is (Discord auto-links it); otherwise append
				// the URI so the link target is visible.
				if ("uri" in f) {
					out = out.trim() === f.uri ? out : `${out} (${f.uri})`;
				}
				break;
			case "space.roomy.richtext.facet#didMention":
				// Bridged Discord users carry `did:discord:<snowflake>`; render a
				// real Discord mention. Roomy-native DIDs stay as plain text.
				if ("did" in f && f.did.startsWith("did:discord:")) {
					out = `<@${f.did.slice("did:discord:".length)}>`;
				}
				break;
			default:
				break; // roomRef, atMention, highlight, unknown → plain text
		}
	}
	return out;
}

/**
 * Render a text-bearing block's inline content (text + facets) into Discord
 * markdown by slicing on facet boundaries and applying features per segment.
 */
function renderInline(text: string, facets: Facet[] | undefined): string {
	if (!facets || facets.length === 0) return text;

	const sorted = [...facets].sort(
		(a, b) => a.index.byteStart - b.index.byteStart,
	);
	const boundaries = new Set<number>([0, text.length]);
	for (const f of sorted) {
		boundaries.add(utf8ToUtf16(text, f.index.byteStart));
		boundaries.add(utf8ToUtf16(text, f.index.byteEnd));
	}
	const points = [...boundaries].sort((a, b) => a - b);

	let out = "";
	for (let i = 0; i < points.length - 1; i++) {
		const start = points[i];
		const end = points[i + 1];
		if (start === undefined || end === undefined || end <= start) continue;
		const segment = text.slice(start, end);
		if (!segment) continue;
		const features: FacetFeature[] = [];
		for (const f of sorted) {
			const fStart = utf8ToUtf16(text, f.index.byteStart);
			const fEnd = utf8ToUtf16(text, f.index.byteEnd);
			if (start >= fStart && end <= fEnd) {
				features.push(...f.features);
			}
		}
		out += features.length > 0 ? applyFeatures(segment, features) : segment;
	}
	return out;
}

/**
 * The `text` (and optional `facets`) of a text-bearing block, or undefined for
 * block types without text (lists, image, horizontal rule). Uses `in` guards
 * to narrow the open block union without type assertions.
 */
function textOf(block: Block): { text: string; facets?: Facet[] } | undefined {
	if (!("text" in block)) return undefined;
	return {
		text: block.text ?? "",
		facets: "facets" in block ? block.facets : undefined,
	};
}

/**
 * Convert an array of blocks into a Discord markdown string. Unknown block
 * types fall back to their `text` if present (open union).
 */
export function blocksToDiscordMarkdown(blocks: Block[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		switch (block.$type) {
			case "space.roomy.richtext.blocks#text": {
				const t = textOf(block);
				if (t) parts.push(renderInline(t.text, t.facets));
				break;
			}
			case "space.roomy.richtext.blocks#header": {
				const t = textOf(block);
				// Discord has no headings — bold is the closest approximation.
				if (t) parts.push(`**${renderInline(t.text, t.facets)}**`);
				break;
			}
			case "space.roomy.richtext.blocks#blockquote": {
				const t = textOf(block);
				if (!t) break;
				const level = "level" in block && typeof block.level === "number"
					? Math.max(1, Math.floor(block.level))
					: 1;
				parts.push(`${">".repeat(level)} ${renderInline(t.text, t.facets)}`);
				break;
			}
			case "space.roomy.richtext.blocks#small": {
				const t = textOf(block);
				// Discord's `-# small text` renders smaller than body text.
				if (t) parts.push(`-# ${renderInline(t.text, t.facets)}`);
				break;
			}
			case "space.roomy.richtext.blocks#code": {
				const t = textOf(block);
				if (!t) break;
				const language = "language" in block ? block.language : undefined;
				parts.push(
					language
						? `\`\`\`${language}\n${t.text}\n\`\`\``
						: `\`\`\`\n${t.text}\n\`\`\``,
				);
				break;
			}
			case "space.roomy.richtext.blocks#orderedList":
				if ("items" in block) {
					block.items.forEach((item, i) => {
						parts.push(`${i + 1}. ${renderInline(item.text, item.facets)}`);
					});
				}
				break;
			case "space.roomy.richtext.blocks#unorderedList":
				if ("items" in block) {
					block.items.forEach((item) => {
						parts.push(`- ${renderInline(item.text, item.facets)}`);
					});
				}
				break;
			case "space.roomy.richtext.blocks#image":
				if ("uri" in block && block.uri) parts.push(block.uri);
				break;
			case "space.roomy.richtext.blocks#horizontalRule":
				parts.push("---");
				break;
			default: {
				const t = textOf(block);
				if (t?.text) parts.push(t.text);
				break;
			}
		}
	}
	return parts.join("\n");
}
