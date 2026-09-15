/**
 * Unit tests for LiveDiscordDataSource.getPublicArchivedThreads.
 *
 * Covers the two behaviors the archived-thread backfill depends on:
 *   1. The snowflake cursor must survive discordeno's `before` encoding.
 *      @discordeno/rest routes.cjs builds the URL as
 *      `before=${new Date(before).toISOString()}`, so the value we pass
 *      must be a valid epoch-ms Date. Pre-fix the code passed
 *      `Number(snowflake)` (~7.2e17, outside Date's ±8.64e15 ms range),
 *      which made `.toISOString()` throw `RangeError: Invalid Date`
 *      on the second page of every archived-thread backfill.
 *   2. A transient REST failure is retried with backoff, so one bad page
 *      costs retry latency, not the parent channel's remaining history.
 */

import { describe, expect, test } from "bun:test";
import { LiveDiscordDataSource } from "../live-data-source.ts";
import type { DiscordBot } from "../types.ts";

const CHANNEL = "1475625518132105319";
// Real-world archived-thread snowflake cursor (18-digit Discord ID).
const SNOWFLAKE = "720751906225586180";
const DISCORD_EPOCH_MS = 1420070400000;

/** Epoch ms encoded in a snowflake (upper 22 bits) — mirrors the fix. */
function snowflakeEpochMs(snowflake: string): number {
	return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
}

interface FakeBot {
	helpers: {
		getPublicArchivedThreads: (
			channelId: bigint,
			options?: { limit?: number; before?: number },
		) => Promise<{
			threads: Array<{ id: string; type: number; name: string }>;
			members: unknown[];
			hasMore: boolean;
		}>;
	};
}

function makeDataSource(failFirst: number): {
	ds: LiveDiscordDataSource;
	calls: Array<{ before: number | undefined; limit: number | undefined }>;
} {
	const calls: Array<{ before: number | undefined; limit: number | undefined }> =
		[];
	let remainingFailures = failFirst;
	const bot: FakeBot = {
		helpers: {
			getPublicArchivedThreads: async (_channelId, options) => {
				calls.push({ before: options?.before, limit: options?.limit });
				if (remainingFailures > 0) {
					remainingFailures--;
					throw new Error("simulated REST failure");
				}
				return {
					threads: [{ id: SNOWFLAKE, type: 11, name: "archived" }],
					members: [],
					hasMore: false,
				};
			},
		},
	};
	return {
		ds: new LiveDiscordDataSource(bot as unknown as DiscordBot),
		calls,
	};
}

describe("LiveDiscordDataSource.getPublicArchivedThreads", () => {
	test("passes a snowflake cursor as epoch-ms that survives discordeno's ISO encoding", async () => {
		const { ds, calls } = makeDataSource(0);

		const page = await ds.getPublicArchivedThreads(CHANNEL, {
			before: SNOWFLAKE,
			limit: 100,
		});

		const call = calls[0];
		expect(call).toBeDefined();
		const before = call?.before;
		expect(before).toBeDefined();

		// Replicate discordeno's route encoding: `new Date(before).toISOString()`.
		// Pre-fix this threw RangeError — Number(snowflake) is an Invalid Date.
		if (before === undefined) throw new Error("before was not passed");
		const encoded = new Date(before).toISOString();

		// The cursor must be the snowflake's own creation time, losslessly.
		expect(before).toBe(snowflakeEpochMs(SNOWFLAKE));
		expect(encoded).toBe(new Date(snowflakeEpochMs(SNOWFLAKE)).toISOString());

		// Page passes through normalized.
		expect(page.hasMore).toBe(false);
		expect(page.threads[0]?.id).toBe(SNOWFLAKE);
	});

	test("omits before when no cursor is given", async () => {
		const { ds, calls } = makeDataSource(0);

		await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls[0]?.before).toBeUndefined();
		expect(calls[0]?.limit).toBe(100);
	});

	test("retries a transient page failure with backoff before succeeding", async () => {
		const { ds, calls } = makeDataSource(2); // 2 failed attempts, then success

		const page = await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls).toHaveLength(3); // budget: 3 attempts total
		expect(page.threads).toHaveLength(1);
	});

	test("throws after the retry budget is exhausted", async () => {
		const { ds, calls } = makeDataSource(10); // always failing

		await expect(
			ds.getPublicArchivedThreads(CHANNEL, { limit: 100 }),
		).rejects.toThrow("simulated REST failure");
		expect(calls).toHaveLength(3); // bounded — no unbounded retry loop
	});
});
