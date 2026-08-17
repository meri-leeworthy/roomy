/**
 * Unit tests for LiveDiscordSender (Roomy → Discord).
 *
 * Covers the real-API behaviour that the FileDiscordSender mock can't:
 * replies must be sent via the bot's createMessage endpoint (Discord
 * webhooks do not support `message_reference`), while normal messages use
 * the webhook for custom attribution and files go through the webhook
 * multipart upload.
 */

import { describe, expect, test } from "bun:test";
import { LiveDiscordSender } from "../live-sender.ts";
import type { DiscordBot } from "../types.ts";

const CHANNEL = "1475625518132105319";

interface FakeBot {
	helpers: {
		sendMessage: (channelId: bigint, opts: unknown) => Promise<{ id: bigint }>;
	};
	rest: {
		post: (url: string, opts: unknown) => Promise<{ id: string }>;
	};
}

function makeBot(): FakeBot & { calls: { send: unknown[]; post: unknown[] } } {
	const calls: { send: unknown[]; post: unknown[] } = { send: [], post: [] };
	const bot = {
		helpers: {
			sendMessage: async (channelId: bigint, opts: unknown) => {
				calls.send.push({ channelId, opts });
				return { id: 9001n };
			},
		},
		rest: {
			post: async (url: string, opts: unknown) => {
				calls.post.push({ url, opts });
				return { id: "9002" };
			},
		},
	};
	return { ...bot, calls };
}

function sender(bot: FakeBot): LiveDiscordSender {
	return new LiveDiscordSender(bot as unknown as DiscordBot);
}

describe("LiveDiscordSender", () => {
	test("sends a reply via the bot createMessage endpoint with a message reference", async () => {
		const bot = makeBot();
		const s = sender(bot);
		const id = await s.sendMessage(CHANNEL, "a reply", {
			replyToMessageId: "1538815791569309696",
		});

		expect(id).toBe("9001");
		expect(bot.calls.send).toHaveLength(1);
		expect(bot.calls.post).toHaveLength(0); // NOT via webhook
		const send = bot.calls.send[0] as {
			opts: { content: string; messageReference: { messageId: bigint; channelId: bigint; failIfNotExists: boolean } };
		};
		expect(send.opts.content).toBe("a reply");
		expect(send.opts.messageReference.messageId).toBe(1538815791569309696n);
		expect(send.opts.messageReference.channelId).toBe(BigInt(CHANNEL));
		expect(send.opts.messageReference.failIfNotExists).toBe(false);
	});

	test("sends a normal message via the webhook when webhook is provided", async () => {
		const bot = makeBot();
		const s = sender(bot);
		const id = await s.sendMessage(CHANNEL, "hello", {
			webhook: { id: "wh1", token: "tok1" },
			username: "Alice",
		});

		expect(id).toBe("9002");
		expect(bot.calls.send).toHaveLength(0);
		expect(bot.calls.post).toHaveLength(1);
		const post = bot.calls.post[0] as { url: string; opts: { body: Record<string, unknown> } };
		expect(post.url).toContain("/webhooks/wh1/tok1?wait=true");
		expect(post.opts.body.content).toBe("hello");
		expect(post.opts.body.username).toBe("Alice");
	});

	test("uploads files via the webhook multipart endpoint", async () => {
		const bot = makeBot();
		const s = sender(bot);
		const data = new TextEncoder().encode("png-bytes");
		await s.sendMessage(CHANNEL, "see image", {
			webhook: { id: "wh1", token: "tok1" },
			files: [{ filename: "a.png", contentType: "image/png", data }],
		});

		expect(bot.calls.post).toHaveLength(1);
		const post = bot.calls.post[0] as { opts: { files: { name: string; blob: Blob }[] } };
		expect(post.opts.files).toHaveLength(1);
		expect(post.opts.files[0]?.name).toBe("a.png");
		expect(post.opts.files[0]?.blob.type).toBe("image/png");
	});
});
