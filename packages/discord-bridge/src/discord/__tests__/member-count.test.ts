/**
 * Unit tests for DiscordMemberCountProvider.
 * Covers: cached-members path (members.size), the getGuild counts fallback,
 * and failure classification from discordeno's wrapped REST error.
 */

import { describe, expect, test } from "bun:test";
import { DiscordMemberCountProvider } from "../member-count.ts";

const GUILD = "123456789012345670";
const GUILD_ID = BigInt(GUILD);

interface FakeBot {
	cache: {
		guilds: {
			memory: {
				get: (id: bigint) =>
					| { members?: { size: number } }
					| undefined;
			};
		};
	};
	helpers: {
		getGuild: (
			id: bigint,
			opts?: { counts?: boolean },
		) => Promise<{ approximateMemberCount?: number }>;
	};
}

function makeBot(): FakeBot & {
	calls: { getGuild: Array<{ id: bigint; opts?: { counts?: boolean } }> };
} {
	const calls: { getGuild: Array<{ id: bigint; opts?: { counts?: boolean } }> } =
		{ getGuild: [] };
	const bot: FakeBot = {
		cache: {
			guilds: {
				memory: {
					get: () => undefined,
				},
			},
		},
		helpers: {
			getGuild: async (id, opts) => {
				calls.getGuild.push({ id, opts });
				return { approximateMemberCount: 42 };
			},
		},
	};
	return { ...bot, calls };
}

function provider(bot: FakeBot): DiscordMemberCountProvider {
	return new DiscordMemberCountProvider(bot as never);
}

describe("DiscordMemberCountProvider", () => {
	test("uses the cached members collection size when present", async () => {
		const bot = makeBot();
		bot.cache.guilds.memory.get = () => ({ members: { size: 7 } });
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toEqual({ ok: true, count: 7 });
		expect(bot.calls.getGuild.length).toBe(0);
	});

	test("falls back to getGuild with counts when no cached members", async () => {
		const bot = makeBot();
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toEqual({ ok: true, count: 42 });
		expect(bot.calls.getGuild).toEqual([
			{ id: GUILD_ID, opts: { counts: true } },
		]);
	});

	test("returns a non-permanent failure when getGuild throws a bare error", async () => {
		const bot = makeBot();
		bot.helpers.getGuild = async () => {
			throw new Error("rate limited");
		};
		const p = provider(bot);

		expect(await p.getMemberCount(GUILD)).toEqual({
			ok: false,
			failure: {
				status: undefined,
				code: undefined,
				message: "rate limited",
				permanent: false,
			},
		});
	});

	test("recovers the HTTP status and Discord error code from the wrapped cause", async () => {
		const bot = makeBot();
		const wrapped = new Error("Failed to send request to discord.");
		Object.assign(wrapped, {
			cause: {
				ok: false,
				status: 404,
				body: JSON.stringify({ message: "Unknown Guild", code: 10004 }),
			},
		});
		bot.helpers.getGuild = async () => {
			throw wrapped;
		};

		expect(await provider(bot).getMemberCount(GUILD)).toEqual({
			ok: false,
			failure: {
				status: 404,
				code: 10004,
				message: "Unknown Guild",
				permanent: true,
			},
		});
	});

	test("403 missing access is permanent; 429 and network failures are transient", async () => {
		const bot = makeBot();
		const failWith = async (cause: unknown) => {
			const wrapped = new Error("Failed to send request to discord.");
			Object.assign(wrapped, { cause });
			bot.helpers.getGuild = async () => {
				throw wrapped;
			};
			return provider(bot).getMemberCount(GUILD);
		};

		expect(
			await failWith({
				ok: false,
				status: 403,
				body: JSON.stringify({ message: "Missing Access", code: 50001 }),
			}),
		).toMatchObject({ ok: false, failure: { status: 403, permanent: true } });

		expect(
			await failWith({
				ok: false,
				status: 429,
				body: JSON.stringify({ message: "You are being rate limited." }),
			}),
		).toMatchObject({ ok: false, failure: { status: 429, permanent: false } });

		expect(
			await failWith({
				ok: false,
				status: 999,
				error: "Possible network or request shape issue occurred.",
			}),
		).toMatchObject({ ok: false, failure: { status: 999, permanent: false } });
	});
});
