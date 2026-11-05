/**
 * Plain data types for Discord entities.
 *
 * These represent just the fields the bridge services actually use,
 * decoupling service logic from Discordeno's heavy type system.
 *
 * Types that are parsed from external JSON (file exports, API responses)
 * are defined as arktype schemas with inferred TypeScript types, so that
 * JSON validation can reuse the same schema and return the right type
 * without casting. Even types that aren't parsed from JSON are defined as
 * schemas here so their inferred types are consistent with the schema types.
 */

import { type } from "arktype";

// ─── Permission overwrite ──────────────────────────────────────────────

export const permissionOverwriteSchema = type({
	id: "string",
	"deny?": "string[]",
});
export type PermissionOverwriteData = typeof permissionOverwriteSchema.infer;

// ─── Users ─────────────────────────────────────────────────────────────

export const DiscordUserData = type({
	id: "string",
	name: "string",
	discriminator: "string",
	"globalName?": "string | null",
	"avatar?": "string | null",
	"isBot?": "boolean",
});
export type DiscordUserData = typeof DiscordUserData.infer;

// ─── Attachments & Media ───────────────────────────────────────────────

export const DiscordAttachmentData = type({
	id: "string",
	url: "string",
	filename: "string",
	"contentType?": "string",
	"size?": "number",
	"width?": "number",
	"height?": "number",
});
export type DiscordAttachmentData = typeof DiscordAttachmentData.infer;

// ─── Message Reference ─────────────────────────────────────────────────

export const DiscordMessageReference = type({
	messageId: "string | null",
	channelId: "string",
	guildId: "string",
});
export type DiscordMessageReference = typeof DiscordMessageReference.infer;

// ─── Reaction emoji ────────────────────────────────────────────────────

export const DiscordReactionEmoji = type({
	id: "string",
	name: "string",
	"animated?": "boolean",
});
export type DiscordReactionEmoji = typeof DiscordReactionEmoji.infer;

// ─── Reactions ─────────────────────────────────────────────────────────

export const DiscordReactionData = type({
	emoji: DiscordReactionEmoji,
	count: "number",
	userIds: "string[]",
});
export type DiscordReactionData = typeof DiscordReactionData.infer;

// ─── Stickers ──────────────────────────────────────────────────────────

export const DiscordStickerData = type({
	id: "string",
	name: "string",
	formatType: "number",
});
export type DiscordStickerData = typeof DiscordStickerData.infer;

// ─── Polls ─────────────────────────────────────────────────────────────

/**
 * A poll reduced to what the bridge renders: its question and answer labels.
 * Discord carries emoji on each answer, but the bridge renders the text the
 * author wrote; emoji-only answers normalise to their emoji name.
 */
export const DiscordPollData = type({
	"question?": "string",
	answers: "string[]",
});
export type DiscordPollData = typeof DiscordPollData.infer;

// ─── Embeds ────────────────────────────────────────────────────────────

export const DiscordEmbedData = type({
	"title?": "string",
	"url?": "string",
	"description?": "string",
	"color?": "number",
});
export type DiscordEmbedData = typeof DiscordEmbedData.infer;

// ─── Message Snapshots (forwards) ───────────────────────────────────────

/**
 * Minimal subset of a forwarded message (DiscordMessageSnapshot).
 *
 * Discord only includes a Pick of the original message's fields in a
 * snapshot — notably no author. The bridge only needs content, timestamp,
 * and attachments for snapshot-content fallback.
 */
export const DiscordMessageSnapshotData = type({
	message: {
		content: "string",
		timestamp: "number",
		"attachments?": DiscordAttachmentData.array(),
	},
});
export type DiscordMessageSnapshotData =
	typeof DiscordMessageSnapshotData.infer;

// ─── Messages ──────────────────────────────────────────────────────────

export const DiscordMessageData = type({
	id: "string",
	channelId: "string",
	"guildId?": "string",
	type: "number",
	content: "string",
	timestamp: "number",
	"editedTimestamp?": "number",
	"webhookId?": "string",
	author: DiscordUserData,
	attachments: DiscordAttachmentData.array(),
	"embeds?": DiscordEmbedData.array().or("undefined"),
	"reactions?": DiscordReactionData.array().or("undefined"),
	"mentions?": DiscordUserData.array(),
	"mentionChannelIds?": "string[]",
	"stickerItems?": DiscordStickerData.array().or("undefined"),
	"poll?": DiscordPollData.or("undefined"),
	"componentLabels?": "string[]",
	"messageReference?": DiscordMessageReference.or("undefined"),
	"flags?": "number",
	"messageSnapshots?": DiscordMessageSnapshotData.array().or("undefined"),
});
export type DiscordMessageData = typeof DiscordMessageData.infer;

// ─── Channels ──────────────────────────────────────────────────────────

export const DiscordChannelData = type({
	id: "string",
	type: "number",
	"name?": "string",
	"parentId?": "string",
	"guildId?": "string",
	"topic?": "string | null",
	"ownerId?": "string",
	"position?": "number",
	/**
	 * Newest message id in the channel. Set by Discord whenever the channel
	 * has history — the discriminator for a channel whose history the bot
	 * cannot read (Discord answers an empty page rather than an error).
	 */
	"lastMessageId?": "string | null",
	"permissionOverwrites?": permissionOverwriteSchema.array(),
});
export type DiscordChannelData = typeof DiscordChannelData.infer;

// ─── Guilds ────────────────────────────────────────────────────────────

export const DiscordGuildData = type({
	id: "string",
	"channels?": DiscordChannelData.array(),
});
export type DiscordGuildData = typeof DiscordGuildData.infer;

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Top-level channel types that get a Roomy room.
 *
 * The thread-only parents are here because their threads are their content:
 * Discord refuses a message in a `GuildForum`/`GuildMedia` channel itself, so
 * the room the bridge creates for one exists to be the room its threads link
 * under (`handleThreadCreate` needs a parent room to link a thread to). The
 * parent room carries no messages of its own.
 */
export const CHANNEL_TYPES = new Set([0, 5, 15, 16]); // GuildText, GuildAnnouncement, GuildForum, GuildMedia

/** Top-level channel types that carry their own message timeline. */
export const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GuildText, GuildAnnouncement

/** Channel types whose content is the threads created in them, not messages. */
export const THREAD_ONLY_PARENT_TYPES = new Set([15, 16]); // GuildForum, GuildMedia

/**
 * Channel types that represent threads (public, private, announcement).
 */
export const THREAD_TYPES = new Set([11, 12, 10]); // PublicThread, PrivateThread, AnnouncementThread

/** Private thread type — excluded from sync. */
export const PRIVATE_THREAD = 12;

/**
 * Guild category — a grouping header, not a channel. Never bridged as a room;
 * read only for initial-sync structure (see services/room-sync.ts).
 */
export const CATEGORY_TYPE = 4;

/** Any channel type that can carry messages. */
export const MESSAGE_CHANNEL_TYPES = new Set([
	...TEXT_CHANNEL_TYPES,
	...THREAD_TYPES,
]);

/** Discord's name for a channel type, for log lines and durable reasons. */
export const CHANNEL_TYPE_NAMES: Record<number, string> = {
	0: "GuildText",
	2: "GuildVoice",
	4: "GuildCategory",
	5: "GuildAnnouncement",
	13: "GuildStageVoice",
	14: "GuildDirectory",
	15: "GuildForum",
	16: "GuildMedia",
};

/**
 * Why a channel type can never have a Roomy room, or null when it can.
 *
 * Threads return null: they are bridged as rooms under their parent, and a
 * category returns null because it is sidebar structure the initial sync
 * reads, never a channel. Every type that does come back non-null has no
 * timeline Roomy can model — a stage or directory channel, a voice channel's
 * side chat — so the bridge refuses it once, by this text, rather than
 * rediscovering the same answer for every message it carries.
 */
export function unbridgedChannelReason(type: number): string | null {
	if (CHANNEL_TYPES.has(type) || THREAD_TYPES.has(type)) return null;
	if (type === CATEGORY_TYPE) return null;
	return (
		`channel type ${type} (${CHANNEL_TYPE_NAMES[type] ?? "unknown"}) has no Roomy equivalent; ` +
		"only text, announcement, forum and media channels are bridged, so every message in it is dropped"
	);
}

/**
 * Check if a channel is publicly visible by examining whether the @everyone
 * role (whose ID equals the guild ID) has VIEW_CHANNEL explicitly denied.
 * Channels without a matching deny overwrite are public by default.
 */
export function isChannelPublic(
	channel: { permissionOverwrites?: Array<{ id: string; deny?: string[] }> },
	guildId: string,
): boolean {
	const overwrites = channel.permissionOverwrites;
	if (!overwrites || overwrites.length === 0) return true;
	const everyoneOverwrite = overwrites.find((o) => o.id === guildId);
	if (!everyoneOverwrite) return true;
	return !everyoneOverwrite.deny?.includes("VIEW_CHANNEL");
}

/** Mapping from Discord channel types to sensible kind strings. */
export function mappingKindForChannel(channel: {
	type: number;
}): "channel" | "thread" {
	return THREAD_TYPES.has(channel.type) ? "thread" : "channel";
}

/** Discord message types the bridge cares about. */
export const MsgType = {
	Default: 0,
	ChannelNameChange: 4,
	ThreadCreated: 18,
	ThreadStarterMessage: 21,
} as const;

/**
 * Discord MessageFlags bit for HAS_SNAPSHOT (1 << 14).
 *
 * "This message has a snapshot (via Message Forwarding)". Discord forwards
 * are ordinary DEFAULT messages (type 0) carrying this flag plus a
 * `message_snapshots` array — there is no dedicated forward message type.
 */
export const MESSAGE_FLAG_HAS_SNAPSHOT = 1 << 14;
