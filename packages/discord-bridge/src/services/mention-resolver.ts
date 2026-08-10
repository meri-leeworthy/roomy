/**
 * Resolve Discord mention syntax inline in message content into Roomy
 * blocks+facets (`space.roomy.richtext.*`).
 *
 * Discord's mention syntax is translated to Roomy's structured model:
 *
 *   <@!?12345>            → `@DisplayName` text + a `#didMention` facet
 *                           carrying `did:discord:12345`
 *   <#12345>              → `#channel-name` text + `#roomRef`/`#link` facets
 *                           carrying the mapped Roomy room ULID (when bridged)
 *   <:name:id> / <a:name:id> → stripped (custom emoji)
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

/**
 * Resolve Discord-specific mention and emoji syntax in message content into
 * a Roomy `#text` block with `#didMention` / `#roomRef` facets.
 *
 * @param content - Raw message content from Discord.
 * @param mentions - Parsed Discord mention objects (from msg.mentions).
 * @param ctx - Pre-resolved channel names and roomy room IDs.
 * @param spaceDid - The target space, used to build `#roomRef` spaceId.
 * @returns A single `#text` block (or an empty array for empty content).
 */
export function resolveMentionsToBlocks(
	content: string,
	mentions: UserMention[] | undefined,
	ctx: MentionContext,
	spaceDid: string,
): Block[] {
	if (!content) return [];

	// Build user display name map from structured mention data.
	const userMap = new Map<string, string>();
	for (const u of mentions || []) {
		const displayName = u.globalName || u.username;
		userMap.set(u.id.toString(), displayName);
	}

	// Tokenize content into plain-text runs and mentions. Each mention becomes
	// a segment with its display text and the facets annotating that span.
	// Custom emoji contribute no text (stripped), so surrounding spacing is
	// preserved exactly as in the legacy markdown path.
	const segments: Segment[] = [];
	const pattern = /<@!?(\d+)>|<#(\d+)>|<a?:(\w+):(\d+)>/g;
	let last = 0;
	let m = pattern.exec(content);
	while (m !== null) {
		if (m.index > last) {
			segments.push({ text: content.slice(last, m.index), features: [] });
		}
		const userSnowflake = m[1];
		const channelSnowflake = m[2];
		if (userSnowflake !== undefined) {
			const name = userMap.get(userSnowflake) ?? userSnowflake;
			segments.push({
				text: `@${name}`,
				features: [
					{
						$type: "space.roomy.richtext.facet#didMention",
						did: `did:discord:${userSnowflake}`,
					},
				],
			});
		} else if (channelSnowflake !== undefined) {
			const displayName =
				ctx.channelNames.get(channelSnowflake) ?? channelSnowflake;
			const roomyRoomId = ctx.roomyRoomIds.get(channelSnowflake);
			const features: FacetFeature[] = [];
			if (roomyRoomId) {
				features.push(
					{
						$type: "space.roomy.richtext.facet#roomRef",
						spaceId: spaceDid,
						roomId: roomyRoomId,
					},
					{
						$type: "space.roomy.richtext.facet#link",
						uri: `/${spaceDid}/${roomyRoomId}`,
					},
				);
			}
			segments.push({ text: `#${displayName}`, features });
		}
		// Emoji (m[3]/m[4]) → stripped, contributes no text.
		last = m.index + m[0].length;
		m = pattern.exec(content);
	}
	if (last < content.length) {
		segments.push({ text: content.slice(last), features: [] });
	}

	const text = segments.map((s) => s.text).join("");
	const facets = [];
	let byte = 0;
	for (const seg of segments) {
		if (seg.features.length > 0 && seg.text.length > 0) {
			const start = byte;
			const end = byte + utf8ByteLength(seg.text);
			facets.push({
				index: { byteStart: start, byteEnd: end },
				features: seg.features,
			});
		}
		byte += utf8ByteLength(seg.text);
	}

	const block: Block =
		facets.length > 0
			? { $type: "space.roomy.richtext.blocks#text", text, facets }
			: { $type: "space.roomy.richtext.blocks#text", text };

	log.debug(
		`Resolved mentions in ${content.length} chars → ${text.length} chars (${facets.length} facets)`,
	);

	return [block];
}
