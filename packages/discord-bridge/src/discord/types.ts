import {
	type Bot,
	type Channel,
	type CompleteDesiredProperties,
	createDesiredPropertiesObject,
	type Interaction,
	type Message,
	type RecursivePartial,
	type SetupDesiredProps,
	type TransformersDesiredProperties,
} from "@discordeno/bot";

export const desiredProperties = createDesiredPropertiesObject({
	message: {
		id: true,
		guildId: true,
		content: true,
		channelId: true,
		author: true,
		webhookId: true,
		editedTimestamp: true,
		attachments: true,
		embeds: true,
		messageReference: true,
		type: true,
		reactions: true,
		stickerItems: true,
		mentions: true,
		mentionedChannelIds: true,
		mentionedRoleIds: true,
		messageSnapshots: true,
		poll: true,
		components: true,
	},
	messageSnapshot: {
		message: true,
	},
	poll: {
		question: true,
		answers: true,
	},
	pollMedia: {
		text: true,
	},
	guild: {
		id: true,
		channels: true,
		ownerId: true,
		approximateMemberCount: true,
	},
	channel: {
		id: true,
		lastMessageId: true,
		name: true,
		type: true,
		guildId: true,
		parentId: true,
		position: true,
		permissionOverwrites: true,
		ownerId: true,
	},
	user: {
		username: true,
		avatar: true,
		id: true,
		discriminator: true,
		globalName: true,
	},
	interaction: {
		id: true,
		type: true,
		data: true,
		token: true,
		guildId: true,
		member: true,
		user: true,
		authorizingIntegrationOwners: true,
	},
	attachment: {
		id: true,
		filename: true,
		contentType: true,
		size: true,
		url: true,
		proxyUrl: true,
		width: true,
		height: true,
	},
	emoji: {
		id: true,
		name: true,
	},
	messageReference: {
		messageId: true,
		channelId: true,
		guildId: true,
	},
	member: {
		id: true,
		guildId: true,
	},
	webhook: {
		id: true,
		token: true,
	},
} satisfies RecursivePartial<TransformersDesiredProperties>);

export type MessageProperties = SetupDesiredProps<
	Message,
	CompleteDesiredProperties<typeof desiredProperties>
>;

export type ChannelProperties = SetupDesiredProps<
	Channel,
	CompleteDesiredProperties<typeof desiredProperties>
>;

export type InteractionProperties = SetupDesiredProps<
	Interaction,
	CompleteDesiredProperties<typeof desiredProperties>
>;

export type DiscordBot = Bot<
	CompleteDesiredProperties<typeof desiredProperties>
>;

// Channel-type sets and message types live in data.ts, which is the plain-data
// module every service reads. Re-exported here because this module is the one
// the gateway wiring and slash commands already import for Discordeno types.
export {
	CATEGORY_TYPE,
	CHANNEL_TYPES,
	MESSAGE_CHANNEL_TYPES,
	MsgType,
	PRIVATE_THREAD,
	TEXT_CHANNEL_TYPES,
	THREAD_ONLY_PARENT_TYPES,
	THREAD_TYPES,
} from "./data.ts";
