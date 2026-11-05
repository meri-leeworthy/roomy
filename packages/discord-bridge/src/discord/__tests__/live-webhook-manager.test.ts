/**
 * Unit tests for LiveWebhookManager — what a channel's webhook costs when a
 * burst of messages arrives and Discord refuses.
 *
 * Covers: LWM01–LWM06 — one create per channel per burst, a permanent refusal
 * remembered instead of retried, a transient failure still retried, a
 * tokenless response treated as permanent, the refusal cleared by unlinking
 * the channel, and the refusal cache staying bounded.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
	vi,
} from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import { LiveWebhookManager } from "../live-webhook-manager.ts";
import type { DiscordBot } from "../types.ts";
import { WebhookUnavailableError } from "../webhook-manager.ts";

const CHANNEL = "1475625518132105319";
const OTHER_CHANNEL = "1475625518132105320";

type CreatedWebhook = { id: bigint; token?: string };

/**
 * A bot whose `createWebhook` is a script the test supplies. Calls are
 * recorded before the script runs, so a count is the number of attempts
 * Discord would have seen.
 */
class FakeBot {
	createCalls: string[] = [];
	deleteCalls: bigint[] = [];
	#create: (channelId: bigint) => Promise<CreatedWebhook>;

	constructor(create: (channelId: bigint) => Promise<CreatedWebhook>) {
		this.#create = create;
	}

	helpers = {
		createWebhook: async (channelId: bigint): Promise<CreatedWebhook> => {
			this.createCalls.push(channelId.toString());
			return this.#create(channelId);
		},
		deleteWebhook: async (webhookId: bigint): Promise<void> => {
			this.deleteCalls.push(webhookId);
		},
	};
}

/** A discordeno-shaped REST failure: status and body hang off `.cause`. */
function discordError(status: number, message = "Missing Permissions"): Error {
	return new Error("Failed to send request to discord.", {
		cause: {
			ok: false,
			status,
			body: JSON.stringify({ message, code: 50013 }),
		},
	});
}

function manager(bot: FakeBot, repo: BridgeRepository): LiveWebhookManager {
	return new LiveWebhookManager(bot as unknown as DiscordBot, repo);
}

let repo: BridgeRepository;

beforeEach(() => {
	repo = BridgeRepository.open(":memory:");
	// Every refusal logs; keep the run's output to the assertions.
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("LiveWebhookManager", () => {
	/**
	 * LWM01: a burst of messages for one channel produces exactly one create
	 * attempt, and every caller gets the same webhook.
	 */
	test("LWM01: concurrent callers for one channel share one create attempt", async () => {
		let release: (webhook: CreatedWebhook) => void = () => {};
		const bot = new FakeBot(
			() =>
				new Promise<CreatedWebhook>((resolve) => {
					release = resolve;
				}),
		);
		const webhooks = manager(bot, repo);

		const calls = Array.from({ length: 7 }, () =>
			webhooks.ensureWebhook(CHANNEL),
		);
		expect(bot.createCalls).toEqual([CHANNEL]);

		release({ id: 42n, token: "tok" });
		const infos = await Promise.all(calls);

		expect(bot.createCalls).toEqual([CHANNEL]);
		expect(infos.map((info) => info.id)).toEqual(Array(7).fill("42"));
		expect(repo.getWebhookToken(CHANNEL)?.token).toBe("tok");
	});

	/**
	 * LWM02: a permanent refusal is attempted once; a later message for the
	 * same channel does not call Discord again.
	 */
	test("LWM02: a permanent refusal is remembered, not retried", async () => {
		const bot = new FakeBot(async () => {
			throw discordError(403);
		});
		const webhooks = manager(bot, repo);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow(
			WebhookUnavailableError,
		);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toMatchObject({
			permanent: true,
			status: 403,
			channelId: CHANNEL,
		});

		expect(bot.createCalls).toEqual([CHANNEL]);

		// A different channel is unaffected by the cached refusal.
		bot.createCalls.length = 0;
		await expect(webhooks.ensureWebhook(OTHER_CHANNEL)).rejects.toThrow();
		expect(bot.createCalls).toEqual([OTHER_CHANNEL]);
	});

	/**
	 * LWM03: a transient failure is not remembered — the next message tries
	 * again.
	 */
	test("LWM03: a transient failure is retried", async () => {
		const bot = new FakeBot(async () => {
			throw discordError(500, "Internal Server Error");
		});
		const webhooks = manager(bot, repo);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toMatchObject({
			permanent: false,
			status: 500,
		});
		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toMatchObject({
			permanent: false,
			status: 500,
		});

		expect(bot.createCalls).toEqual([CHANNEL, CHANNEL]);
	});

	/**
	 * LWM04: a webhook Discord returns without a token can never be used, so
	 * it is a permanent refusal even though no request failed.
	 */
	test("LWM04: a tokenless webhook is a permanent refusal", async () => {
		const bot = new FakeBot(async () => ({ id: 77n }));
		const webhooks = manager(bot, repo);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toMatchObject({
			permanent: true,
			reason: "Discord returned a webhook with no token",
		});
		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow(
			WebhookUnavailableError,
		);

		expect(bot.createCalls).toEqual([CHANNEL]);
		// The unusable webhook is removed rather than left on the channel.
		expect(bot.deleteCalls).toEqual([77n]);
	});

	/**
	 * LWM05: a refusal expires, so a channel whose permission was granted
	 * bridges again without a restart.
	 */
	test("LWM05: a refusal expires after the TTL", async () => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-10-27T00:00:00Z"));

		const bot = new FakeBot(async () => {
			throw discordError(403);
		});
		const webhooks = manager(bot, repo);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow();

		setSystemTime(new Date("2026-10-27T00:31:00Z"));
		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow();

		expect(bot.createCalls).toEqual([CHANNEL, CHANNEL]);
	});

	/**
	 * LWM06: unlinking a channel forgets its refusal, so re-linking it gets a
	 * fresh attempt.
	 */
	test("LWM06: removeWebhook forgets the refusal", async () => {
		const bot = new FakeBot(async () => {
			throw discordError(403);
		});
		const webhooks = manager(bot, repo);

		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow();
		await webhooks.removeWebhook(CHANNEL);
		await expect(webhooks.ensureWebhook(CHANNEL)).rejects.toThrow();

		expect(bot.createCalls).toEqual([CHANNEL, CHANNEL]);
	});

	/**
	 * LWM07: the refusal cache is bounded — the oldest refusal is evicted
	 * rather than kept forever.
	 */
	test("LWM07: remembered refusals stay bounded", async () => {
		const bot = new FakeBot(async () => {
			throw discordError(403);
		});
		const webhooks = manager(bot, repo);

		for (let channel = 0; channel < 512; channel++) {
			await expect(
				webhooks.ensureWebhook(`90000000000000${channel}`),
			).rejects.toThrow();
		}
		expect(bot.createCalls).toHaveLength(512);

		// One more refusal evicts the first channel, which is asked again.
		await expect(webhooks.ensureWebhook(OTHER_CHANNEL)).rejects.toThrow();
		await expect(webhooks.ensureWebhook("900000000000000")).rejects.toThrow();

		expect(bot.createCalls).toHaveLength(514);
	});
});
