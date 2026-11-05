/**
 * LiveWebhookManager: creates and manages Discord webhooks via the
 * Discordeno bot, persisting webhook tokens in the bridge repository.
 *
 * Creating a webhook is a per-channel operation, not a per-message one, so a
 * burst of messages for a channel must cost one attempt: concurrent callers
 * share the in-flight create, and a refusal no retry can change is remembered
 * so the channel is not asked again for every message that follows.
 */

import type { BridgeRepository } from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import {
	discordFailureDetail,
	isRetryableDiscordStatus,
} from "./rest-errors.ts";
import type { DiscordBot } from "./types.ts";
import {
	type WebhookInfo,
	type WebhookManager,
	WebhookUnavailableError,
} from "./webhook-manager.ts";

const log = createLogger("live-webhook");

/**
 * How long a permanent refusal is served from memory. Long enough that a
 * channel Discord will not give a webhook to costs one attempt per half hour
 * instead of one per message; short enough that granting the bot Manage
 * Webhooks restores bridging without a restart, since the refusal expires.
 */
const REFUSAL_TTL_MS = 30 * 60 * 1_000;

/**
 * How many channels' refusals are remembered before the oldest is dropped.
 * Refusals are per channel and rare, so this only bounds a pathological case
 * (a guild where every channel refuses) rather than sizing normal traffic.
 */
const MAX_REFUSALS = 512;

type Refusal = {
	status: number | undefined;
	reason: string;
	at: number;
};

/** Why Discord refuses a channel, for the statuses it refuses deterministically. */
const REFUSAL_BY_STATUS: Record<number, string> = {
	403: "the bot lacks Manage Webhooks in this channel",
	404: "this channel no longer exists in Discord",
};

/**
 * Why Discord refused webhook creation, in the terms an operator reading a
 * dropped-message record can act on.
 */
function describeRefusal(status: number | undefined): string {
	if (status === undefined) return "Discord returned no HTTP status";
	return (
		REFUSAL_BY_STATUS[status] ??
		`Discord refused webhook creation (status ${status})`
	);
}

export class LiveWebhookManager implements WebhookManager {
	#bot: DiscordBot;
	#repo: BridgeRepository;
	/** One create in flight per channel: concurrent callers await the same attempt. */
	#inflight = new Map<string, Promise<WebhookInfo>>();
	/** Channels whose webhook Discord will not create, until the entry expires. */
	#refusals = new Map<string, Refusal>();

	constructor(bot: DiscordBot, repo: BridgeRepository) {
		this.#bot = bot;
		this.#repo = repo;
	}

	async ensureWebhook(channelId: string): Promise<WebhookInfo> {
		// Check for an existing webhook
		const existing = this.#repo.getWebhookToken(channelId);
		if (existing) {
			this.#refusals.delete(channelId);
			return { id: existing.webhookId, token: existing.token };
		}

		const refusal = this.#activeRefusal(channelId);
		if (refusal) {
			throw new WebhookUnavailableError({
				channelId,
				status: refusal.status,
				reason: refusal.reason,
				permanent: true,
			});
		}

		const inflight = this.#inflight.get(channelId);
		if (inflight) return inflight;

		const attempt = this.#createWebhook(channelId).finally(() => {
			this.#inflight.delete(channelId);
		});
		this.#inflight.set(channelId, attempt);
		return attempt;
	}

	async removeWebhook(channelId: string): Promise<void> {
		// Unlinking a channel forgets why its webhook failed, so re-linking it
		// gets a fresh attempt rather than waiting out the refusal TTL.
		this.#refusals.delete(channelId);

		const existing = this.#repo.getWebhookToken(channelId);
		if (!existing) return;

		try {
			await this.#bot.helpers.deleteWebhook(BigInt(existing.webhookId));
		} catch (err) {
			log.warn(
				`Failed to delete webhook for channel ${channelId}; keeping token so we can retry later`,
				err,
			);
			// Don't delete the repo row — the token may still be valid and we
			// want removeWebhook to be retryable.
			return;
		}

		this.#repo.deleteWebhookToken(channelId);
		log.info(`Removed webhook for channel ${channelId}`);
	}

	/** The unexpired refusal remembered for a channel, if any. */
	#activeRefusal(channelId: string): Refusal | undefined {
		const refusal = this.#refusals.get(channelId);
		if (!refusal) return undefined;
		if (Date.now() - refusal.at < REFUSAL_TTL_MS) return refusal;
		this.#refusals.delete(channelId);
		return undefined;
	}

	async #createWebhook(channelId: string): Promise<WebhookInfo> {
		try {
			const webhook = await this.#bot.helpers.createWebhook(BigInt(channelId), {
				name: "Roomy Bridge",
			});

			if (!webhook.token) {
				// Discord sometimes returns webhooks without a token (e.g. for
				// application-owned webhooks). Delete the unusable webhook so the
				// channel is left as it was found.
				try {
					await this.#bot.helpers.deleteWebhook(BigInt(webhook.id));
				} catch (deleteErr) {
					log.warn(
						`Failed to delete tokenless webhook ${webhook.id} for channel ${channelId}`,
						deleteErr,
					);
				}
				throw new WebhookUnavailableError({
					channelId,
					status: undefined,
					reason: "Discord returned a webhook with no token",
					permanent: true,
				});
			}

			const info: WebhookInfo = {
				id: webhook.id.toString(),
				token: webhook.token,
			};
			this.#repo.setWebhookToken(channelId, info.id, info.token);
			this.#refusals.delete(channelId);
			log.info(`Created webhook for channel ${channelId}`);
			return info;
		} catch (err) {
			throw this.#failure(channelId, err);
		}
	}

	/**
	 * The error a caller receives for a failed create. A permanent refusal is
	 * remembered here, so the channel is asked once rather than once per
	 * message; a transient one is not, so the next message retries.
	 */
	#failure(channelId: string, err: unknown): WebhookUnavailableError {
		const refusal = this.#classify(channelId, err);
		if (refusal.permanent) {
			this.#rememberRefusal(channelId, refusal);
			log.error(
				`Failed to create webhook for channel ${channelId}: ${refusal.reason}; not retrying until the refusal expires`,
				err instanceof Error ? err : refusal,
			);
		} else {
			log.warn(
				`Failed to create webhook for channel ${channelId}: ${refusal.reason}; will retry`,
				err instanceof Error ? err : refusal,
			);
		}
		return refusal;
	}

	/**
	 * Turn a failed create into the error callers receive. Only a status
	 * Discord rejected before executing the request (a 4xx other than 429) is
	 * permanent: a rate limit, a 5xx, or a network failure can succeed later.
	 */
	#classify(channelId: string, err: unknown): WebhookUnavailableError {
		if (err instanceof WebhookUnavailableError) return err;
		const { status } = discordFailureDetail(err);
		return new WebhookUnavailableError({
			channelId,
			status,
			reason: describeRefusal(status),
			permanent: !isRetryableDiscordStatus(status),
		});
	}

	#rememberRefusal(channelId: string, refusal: WebhookUnavailableError): void {
		if (this.#refusals.size >= MAX_REFUSALS && !this.#refusals.has(channelId)) {
			const oldest = this.#refusals.keys().next();
			if (!oldest.done) this.#refusals.delete(oldest.value);
		}
		this.#refusals.set(channelId, {
			status: refusal.status,
			reason: refusal.reason,
			at: Date.now(),
		});
	}
}
