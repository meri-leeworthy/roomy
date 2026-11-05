/**
 * Periodic capacity sweep for bridged (guild, space) tuples.
 *
 * The sweep exists to catch capacity changes that arrive with no member
 * add/remove gateway event: a bridge-token grant shipping (which starts
 * enforcement for a space that was failing open) or a capacity change on the
 * appserver side. No request is answered from it, so it does not need the read
 * path's freshness: it revalidates a decision once it is older than
 * CAPACITY_SWEEP_MAX_AGE_MS, and it never forces a refetch — a decision a real
 * reader already refreshed is left alone.
 *
 * Two properties keep the sweep from becoming a load spike of its own:
 * - It visits one slice of the tuple list per tick, advancing a cursor, so a
 *   full pass takes no longer than CAPACITY_SWEEP_PERIOD_MS and the tuples'
 *   decision ages decorrelate instead of all lapsing in the same event-loop
 *   turn.
 * - Every check runs in a pool of at most CAPACITY_CHECK_CONCURRENCY, and a
 *   tick that arrives while the previous one is still running is skipped, so
 *   in-flight requests never exceed the pool size.
 */

import type { CapacityDecision } from "./capacity.ts";

/** A (guild, space) tuple the sweep visits. */
export interface CapacityTuple {
	guildId: string;
	spaceDid: string;
}

/** Issues capacity checks; `CapacityService` satisfies this. */
export interface CapacityChecker {
	check(
		guildId: string,
		spaceDid: string,
		opts: { force?: boolean; maxAgeMs?: number },
	): Promise<CapacityDecision>;
}

/** Supplies the bridged tuples; `BridgeRepository` satisfies this. */
export interface CapacityTupleSource {
	listAllBridgeConfigs(): CapacityTuple[];
}

/** How often the sweep advances its cursor. */
export const CAPACITY_SWEEP_TICK_MS = 5_000;

/** Wall-clock span of one full pass over the tuple list. */
export const CAPACITY_SWEEP_PERIOD_MS = 300_000;

/** How old a cached decision may be before the sweep revalidates it. Three
 *  times the read path's 300s TTL: a tuple that has traffic is refetched
 *  there, so the sweep only bounds how long a quiet tuple can sit on a
 *  superseded decision. */
export const CAPACITY_SWEEP_MAX_AGE_MS = 900_000;

/** Max capacity checks in flight at once. */
export const CAPACITY_CHECK_CONCURRENCY = 4;

/** Run `op` over `items` with at most `concurrency` promises outstanding. */
async function inPool<T>(
	items: readonly T[],
	concurrency: number,
	op: (item: T) => Promise<unknown>,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next];
			next++;
			if (item === undefined) return;
			await op(item);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.max(1, Math.min(concurrency, items.length)) },
			worker,
		),
	);
}

/** Force a check for every tuple, at most `concurrency` at a time. Used by the
 *  startup pass and the member add/remove triggers, where the point is to have
 *  a fresh decision immediately. */
export async function forceCheckTuples(
	checker: CapacityChecker,
	tuples: readonly CapacityTuple[],
	concurrency: number = CAPACITY_CHECK_CONCURRENCY,
): Promise<void> {
	await inPool(tuples, concurrency, (tuple) =>
		checker.check(tuple.guildId, tuple.spaceDid, { force: true }),
	);
}

export interface CapacitySweepOptions {
	/** How old a cached decision may be before the sweep revalidates it. */
	maxAgeMs?: number;
	/** Wall-clock span of one full pass over the tuple list. */
	periodMs?: number;
	/** Max checks in flight at once. */
	concurrency?: number;
}

export class CapacitySweep {
	#checker: CapacityChecker;
	#tuples: CapacityTupleSource;
	#maxAgeMs: number;
	#ticksPerPeriod: number;
	#concurrency: number;
	#cursor = 0;
	#running = false;

	constructor(
		checker: CapacityChecker,
		tuples: CapacityTupleSource,
		opts: CapacitySweepOptions = {},
	) {
		this.#checker = checker;
		this.#tuples = tuples;
		this.#maxAgeMs = opts.maxAgeMs ?? CAPACITY_SWEEP_MAX_AGE_MS;
		this.#ticksPerPeriod = Math.max(
			1,
			Math.round(
				(opts.periodMs ?? CAPACITY_SWEEP_PERIOD_MS) / CAPACITY_SWEEP_TICK_MS,
			),
		);
		this.#concurrency = opts.concurrency ?? CAPACITY_CHECK_CONCURRENCY;
	}

	/** Visit this tick's slice of the tuple list. Returns how many tuples were
	 *  visited — 0 when a previous tick is still running or nothing is bridged. */
	async tick(): Promise<number> {
		if (this.#running) return 0;
		const all = this.#tuples.listAllBridgeConfigs();
		if (all.length === 0) return 0;

		const sliceSize = Math.max(1, Math.ceil(all.length / this.#ticksPerPeriod));
		const slice: CapacityTuple[] = [];
		for (let i = 0; i < sliceSize; i++) {
			const tuple = all[this.#cursor];
			if (tuple === undefined) break;
			slice.push(tuple);
			this.#cursor = (this.#cursor + 1) % all.length;
		}

		this.#running = true;
		try {
			await inPool(slice, this.#concurrency, (tuple) =>
				this.#checker.check(tuple.guildId, tuple.spaceDid, {
					maxAgeMs: this.#maxAgeMs,
				}),
			);
		} finally {
			this.#running = false;
		}
		return slice.length;
	}
}
