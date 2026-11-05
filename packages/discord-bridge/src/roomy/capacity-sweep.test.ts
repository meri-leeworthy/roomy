/**
 * Unit tests for the periodic capacity sweep.
 *
 * Covers: the sweep visits every bridged tuple once per period across ticks,
 * it never force-bypasses a fresh decision, its in-flight checks stay within
 * the pool size, an overlapping tick is skipped, and the force pass used by
 * startup and member add/remove keeps forcing every tuple within the pool.
 */

import { describe, expect, test, vi } from "bun:test";
import {
	type CapacityDecision,
	CapacityService,
	type MembershipClient,
	type SpaceMembership,
} from "./capacity.ts";
import {
	CAPACITY_SWEEP_TICK_MS,
	type CapacityChecker,
	CapacitySweep,
	type CapacityTuple,
	type CapacityTupleSource,
	forceCheckTuples,
} from "./capacity-sweep.ts";

function decision(guildId: string, spaceDid: string): CapacityDecision {
	return {
		guildId,
		spaceDid,
		memberCount: 50,
		maxMembers: 100,
		overLimit: false,
		hardStop: false,
		stale: false,
		checkedAt: Date.now(),
		enabled: true,
	};
}

function targets(count: number): CapacityTupleSource & {
	tuples: CapacityTuple[];
} {
	const tuples = Array.from({ length: count }, (_, i) => ({
		guildId: `guild-${i}`,
		spaceDid: `did:web:space-${i}.example`,
	}));
	return {
		tuples,
		listAllBridgeConfigs: () => tuples,
	};
}

function membership(over: Partial<SpaceMembership> = {}): SpaceMembership {
	return {
		spaceDid: "did:web:space-0.example",
		tokens: [],
		validTokenCount: 0,
		maxMembers: 100,
		memberCount: 50,
		overLimit: false,
		stale: false,
		checkedAt: Date.now(),
		...over,
	};
}

/** A client that answers with the same membership and counts its calls. */
function countingClient(): MembershipClient & { calls: number } {
	const client = {
		calls: 0,
		async getSpaceMembership() {
			client.calls++;
			return membership();
		},
	};
	return client;
}

/**
 * A checker whose checks stay in flight until the test releases them, so the
 * pool's in-flight count is observable without waiting on wall-clock time.
 */
function gatedChecker() {
	const gates: Array<() => void> = [];
	const state = { inFlight: 0, peak: 0, started: 0 };
	const checker: CapacityChecker = {
		check(guildId, spaceDid) {
			const { promise, resolve } = Promise.withResolvers<CapacityDecision>();
			state.started++;
			state.inFlight++;
			state.peak = Math.max(state.peak, state.inFlight);
			gates.push(() => {
				state.inFlight--;
				resolve(decision(guildId, spaceDid));
			});
			return promise;
		},
	};
	return { checker, gates, state };
}

/** Release one in-flight check and let the pool start the next one. */
async function releaseNext(gates: Array<() => void>): Promise<void> {
	gates.shift()?.();
	await Promise.resolve();
}

describe("CapacitySweep decision reuse", () => {
	test("does not refetch a decision that is still fresh", async () => {
		const client = countingClient();
		const service = new CapacityService(client, {
			async getMemberCount() {
				return 50;
			},
		});
		// A read path resolves the decision first.
		await service.check("guild-0", "did:web:space-0.example");
		expect(client.calls).toBe(1);

		const sweep = new CapacitySweep(service, targets(1));
		await sweep.tick();
		await sweep.tick();

		expect(client.calls).toBe(1);
	});

	test("revalidates a decision that has lapsed past its reuse window", async () => {
		const client = countingClient();
		const service = new CapacityService(client, {
			async getMemberCount() {
				return 50;
			},
		});
		await service.check("guild-0", "did:web:space-0.example");
		expect(client.calls).toBe(1);

		// A zero window means no decision is ever young enough to reuse.
		const sweep = new CapacitySweep(service, targets(1), { maxAgeMs: 0 });
		await sweep.tick();

		expect(client.calls).toBe(2);
	});
});

describe("CapacitySweep cadence", () => {
	test("passes its reuse window and never forces", async () => {
		const calls: Array<{ guildId: string; spaceDid: string; opts: unknown }> =
			[];
		const checker: CapacityChecker = {
			async check(guildId, spaceDid, opts) {
				calls.push({ guildId, spaceDid, opts });
				return decision(guildId, spaceDid);
			},
		};

		const sweep = new CapacitySweep(checker, targets(3), { maxAgeMs: 42_000 });
		await sweep.tick();

		expect(calls.length).toBe(1);
		expect(calls[0]?.opts).toEqual({ maxAgeMs: 42_000 });
	});

	test("one full pass visits every tuple exactly once", async () => {
		const source = targets(120);
		const visited: string[] = [];
		const checker: CapacityChecker = {
			async check(guildId, spaceDid) {
				visited.push(`${guildId}:${spaceDid}`);
				return decision(guildId, spaceDid);
			},
		};

		const sweep = new CapacitySweep(checker, source);

		// 120 tuples over a 300s period in 5s ticks: two tuples per tick, so
		// a pass takes 60 ticks.
		for (let i = 0; i < 60; i++) {
			expect(await sweep.tick()).toBe(2);
		}

		expect(visited.length).toBe(120);
		expect(new Set(visited).size).toBe(120);
	});

	test("an empty bridge list is a no-op", async () => {
		const check = vi.fn(async (guildId: string, spaceDid: string) =>
			decision(guildId, spaceDid),
		);
		const sweep = new CapacitySweep({ check }, targets(0));

		expect(await sweep.tick()).toBe(0);
		expect(check).not.toHaveBeenCalled();
	});
});

describe("CapacitySweep concurrency", () => {
	test("in-flight checks stay within the pool size", async () => {
		const { checker, gates, state } = gatedChecker();
		const sweep = new CapacitySweep(checker, targets(20), {
			concurrency: 3,
			// One tick covers the whole period, so the slice is all 20 tuples.
			periodMs: CAPACITY_SWEEP_TICK_MS,
		});

		const tickDone = sweep.tick();
		// The pool starts filling synchronously; three checks are in flight.
		expect(state.inFlight).toBe(3);

		while (gates.length > 0) {
			await releaseNext(gates);
			expect(state.peak).toBeLessThanOrEqual(3);
		}
		await tickDone;

		expect(state.peak).toBe(3);
		expect(state.started).toBe(20);
	});

	test("a tick that overlaps a running one is skipped", async () => {
		const { checker, gates, state } = gatedChecker();
		const sweep = new CapacitySweep(checker, targets(2), {
			concurrency: 2,
			periodMs: CAPACITY_SWEEP_TICK_MS,
		});

		const tickDone = sweep.tick();
		expect(state.started).toBe(2);

		expect(await sweep.tick()).toBe(0);
		expect(state.started).toBe(2);

		while (gates.length > 0) {
			await releaseNext(gates);
		}
		await tickDone;
	});
});

describe("forceCheckTuples", () => {
	test("forces every tuple, within the pool size", async () => {
		const source = targets(9);
		const calls: Array<{ tuple: string; opts: unknown }> = [];
		const gated = gatedChecker();
		const checker: CapacityChecker = {
			check(guildId, spaceDid, opts) {
				calls.push({ tuple: `${guildId}:${spaceDid}`, opts });
				return gated.checker.check(guildId, spaceDid, opts);
			},
		};

		const done = forceCheckTuples(checker, source.tuples, 2);
		expect(gated.state.inFlight).toBe(2);

		while (gated.gates.length > 0) {
			await releaseNext(gated.gates);
			expect(gated.state.peak).toBeLessThanOrEqual(2);
		}
		await done;

		expect(calls.length).toBe(9);
		for (const call of calls) {
			expect(call.opts).toEqual({ force: true });
		}
		expect(gated.state.peak).toBe(2);
	});
});
