/**
 * WebhookManager: manages Discord webhooks for bridged channels.
 *
 * Webhooks allow the bridge to set custom username and avatar when
 * sending Roomy messages to Discord.
 */

export interface WebhookInfo {
	id: string;
	token: string;
}

/**
 * Why Discord would not give the bridge a webhook for a channel.
 *
 * `permanent` separates a refusal no retry can change (no token returned,
 * missing permission, a channel type that cannot hold a webhook) from a
 * transient failure (rate limit, 5xx, network) that a later attempt may well
 * get through. `status` is Discord's HTTP status when the failure carried
 * one — `undefined` for a tokenless response or a network-level failure.
 */
export class WebhookUnavailableError extends Error {
	readonly channelId: string;
	readonly status: number | undefined;
	readonly reason: string;
	readonly permanent: boolean;

	constructor(refusal: {
		channelId: string;
		status: number | undefined;
		reason: string;
		permanent: boolean;
	}) {
		super(
			`No Discord webhook for channel ${refusal.channelId}: ${refusal.reason}`,
		);
		this.name = "WebhookUnavailableError";
		this.channelId = refusal.channelId;
		this.status = refusal.status;
		this.reason = refusal.reason;
		this.permanent = refusal.permanent;
	}
}

export interface WebhookManager {
	/** Get or create a webhook for the given channel. */
	ensureWebhook(channelId: string): Promise<WebhookInfo>;

	/** Delete the webhook for a channel (e.g., on unbridge). */
	removeWebhook(channelId: string): Promise<void>;
}
