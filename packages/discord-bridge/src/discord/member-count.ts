/**
 * DiscordMemberCountProvider: supplies a bridged guild's current member
 * count for capacity checks.
 *
 * Source order (per the capacity contract):
 * 1. Guild cache from @discordeno/bot — when the cached guild carries a
 *    `members` collection (only populated when members are cached in
 *    memory), the count is `members.size`.
 * 2. Fallback: `getGuild(guildId, { counts: true })` → `approximateMemberCount`
 *    (Discord's `with_counts` REST param).
 *
 * The bridge's cache config does not cache members in memory, so the
 * fallback is the effective path today; the cache branch exists so the
 * provider stays correct if the cache config changes.
 *
 * Bots count as members: Discord's member count (both the cached members
 * collection and `approximateMemberCount`) includes bots, and the capacity
 * contract treats every guild member as capacity-consuming. No precedent in
 * the codebase excludes bots, so none is applied here.
 *
 * Failures are returned, not swallowed: discordeno replaces the REST error
 * message with a generic one and hangs the real response off `cause`, so this
 * module recovers the HTTP status and Discord error code, logs them next to
 * the guild id, and classifies the refusal as permanent (retrying cannot
 * succeed) or transient.
 */

import type { DiscordBotWithCache } from "./cache.ts";
import type {
	MemberCountFailure,
	MemberCountLookup,
	MemberCountProvider,
} from "../roomy/capacity.ts";
import {
	discordFailureCode,
	discordFailureDetail,
	discordFailureMessage,
	isRetryableDiscordStatus,
} from "./rest-errors.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("member-count");

/**
 * Recover the Discord failure class from an error thrown by
 * @discordeno/bot's REST layer. Neither the bot token nor the request URL
 * appears in the cause, so everything logged here is safe to emit.
 */
export function describeDiscordFailure(err: unknown): MemberCountFailure {
	const { status } = discordFailureDetail(err);
	return {
		status,
		code: discordFailureCode(err),
		message:
			discordFailureMessage(err) ??
			(err instanceof Error ? err.message : undefined),
		permanent: !isRetryableDiscordStatus(status),
	};
}

export class DiscordMemberCountProvider implements MemberCountProvider {
	#bot: DiscordBotWithCache;

	constructor(bot: DiscordBotWithCache) {
		this.#bot = bot;
	}

	async getMemberCount(guildId: string): Promise<MemberCountLookup> {
		const id = BigInt(guildId);

		const cached = this.#bot.cache.guilds.memory.get(id);
		if (cached?.members) {
			return { ok: true, count: cached.members.size };
		}

		try {
			const guild = await this.#bot.helpers.getGuild(id, { counts: true });
			const count = guild.approximateMemberCount;
			if (typeof count !== "number") {
				log.warn(
					`getMemberCount returned no approximateMemberCount for guild ${guildId}`,
					{ guildId },
				);
				return { ok: false, failure: { permanent: false } };
			}
			return { ok: true, count };
		} catch (err) {
			const failure = describeDiscordFailure(err);
			log.warn(
				`getMemberCount failed for guild ${guildId} (Discord status ${failure.status ?? "unknown"}${
					failure.code === undefined ? "" : `, code ${failure.code}`
				}${failure.permanent ? ", permanent" : ""})`,
				{
					guildId,
					status: failure.status,
					discordCode: failure.code,
					discordMessage: failure.message,
					permanent: failure.permanent,
				},
			);
			return { ok: false, failure };
		}
	}
}
