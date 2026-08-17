/**
 * DiscordSender: abstraction over sending messages, edits, deletes,
 * and reactions to Discord.
 *
 * Decouples the Roomy→Discord routing logic from the concrete Discord
 * API, enabling tests to use an in-memory mock.
 */

export interface SendMessageOptions {
	/** Custom username (requires webhook). */
	username?: string;
	/** Custom avatar URL (requires webhook). */
	avatarUrl?: string;
	/** Webhook credentials for custom author display. */
	webhook?: { id: string; token: string };
	/** Thread ID — when set, the webhook message is sent to this thread. */
	threadId?: string;
	/** Files to attach to the message (multipart webhook upload). */
	files?: Array<{
		filename: string;
		contentType: string;
		data: Uint8Array<ArrayBuffer>;
	}>;
}

export interface DiscordSender {
	/**
	 * Send a message to a Discord channel/thread.
	 * Returns the Discord message snowflake.
	 */
	sendMessage(
		channelId: string,
		content: string,
		options?: SendMessageOptions,
	): Promise<string>;

	/** Edit a message in Discord.
	 * If a webhook is provided, uses the webhook's own edit endpoint
	 * (required for messages sent via webhook, since the bot can't edit
	 * webhook-authored messages). */
	editMessage(
		channelId: string,
		messageId: string,
		content: string,
		webhook?: { id: string; token: string },
	): Promise<void>;

	/** Delete a message from Discord. */
	deleteMessage(channelId: string, messageId: string): Promise<void>;

	/** Add a reaction to a Discord message. */
	addReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void>;

	/** Remove a reaction from a Discord message. */
	removeReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void>;

	/**
	 * Get the parent channel ID for a thread, or undefined if the channel
	 * is not a thread or the parent is unknown.
	 */
	getParentChannelId(channelId: string): Promise<string | undefined>;

	/**
	 * Get the guild ID a channel belongs to, or undefined if unknown.
	 */
	getGuildId(channelId: string): Promise<string | undefined>;

	/**
	 * Fetch a message's content (used to build faux reply/forward prefixes).
	 * Returns undefined if the message can't be fetched.
	 */
	getMessage(
		channelId: string,
		messageId: string,
	): Promise<{ content: string } | undefined>;

	/**
	 * Create a thread in a Discord channel.
	 * Returns the Discord thread snowflake.
	 */
	createThread(
		channelId: string,
		name: string,
		isPrivate: boolean,
	): Promise<string>;
}
