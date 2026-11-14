/**
 * Worker liveness for the container health check.
 *
 * The bridge's useful work happens on timers and sockets: the Discord gateway
 * delivers events, the per-space sync subscriptions deliver Roomy events, and
 * two independent sweeps re-offer queued sends (every minute) and refresh
 * capacity decisions (every five minutes). A listening HTTP server proves none
 * of them are running — it keeps answering from a process whose event loop is
 * blocked, whose gateway dropped, or whose timers never fire.
 *
 * So the report is built from what the worker last observed, not from the
 * fact that this code ran. Each sweep records its completion timestamp from
 * the interval callback itself; if a sweep stops running, its age crosses
 * {@link SEND_RETRY_SWEEP_STALE_MS} / {@link CAPACITY_SWEEP_STALE_MS} and the
 * report turns unhealthy. That is also what catches a blocked event loop: the
 * request that builds the report runs on the same loop, so a loop that can
 * serve it can also run the timers — a loop that cannot run the timers leaves
 * the ages growing.
 *
 * Scope: liveness, not per-item success. A sweep that ran but failed to
 * deliver a particular item is reported by its own logs and the failed-send
 * queue; here it counts as a beat, because the worker was alive to attempt it.
 */

/** Aggregate state of the per-space Roomy sync subscriptions. */
export type SubscriptionState =
	/** No space is bridged yet: there is nothing to keep open. */
	| "idle"
	/** Every bridged space has an open sync connection. */
	| "open"
	/** At least one bridged space's connection is not open. */
	| "not-open";

export const SEND_RETRY_SWEEP_INTERVAL_MS = 60_000;
export const CAPACITY_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * How late a sweep may be before it counts as stopped. Three intervals allows
 * one late tick plus the tick that would have run: a single slow sweep, or a
 * sweep that threw and is retried on the next tick, never trips it.
 */
export const SWEEP_STALE_AFTER_INTERVALS = 3;
export const SEND_RETRY_SWEEP_STALE_MS =
	SEND_RETRY_SWEEP_INTERVAL_MS * SWEEP_STALE_AFTER_INTERVALS;
export const CAPACITY_SWEEP_STALE_MS =
	CAPACITY_SWEEP_INTERVAL_MS * SWEEP_STALE_AFTER_INTERVALS;

/** What the report observed, in the same vocabulary a probe sees. */
export interface HealthChecks {
	discordGateway: "connected" | "disconnected";
	roomySubscriptions: SubscriptionState;
	/** Age of the last completed one-minute send re-offer sweep, in ms. */
	sendRetrySweepAgeMs: number | null;
	/** Age of the last completed five-minute capacity sweep, in ms. */
	capacitySweepAgeMs: number | null;
}

export interface HealthReport {
	status: "ok" | "unhealthy";
	checks: HealthChecks;
	/** Components that failed, each as `<name>: <what was observed>`. */
	reasons: string[];
}

export interface HealthInputs {
	now: number;
	gatewayConnected: boolean;
	subscriptions: SubscriptionState;
	/** Completion timestamp, or `undefined` when the sweep never ran. */
	lastSendRetrySweepAt: number | undefined;
	lastCapacitySweepAt: number | undefined;
}

/**
 * Evaluate the inputs into a report. Pure: the class below only records
 * timestamps and delegates here, so the state machine is testable without a
 * clock or a running bridge.
 */
export function evaluateHealth(inputs: HealthInputs): HealthReport {
	const reasons: string[] = [];

	if (!inputs.gatewayConnected) {
		reasons.push("discord-gateway: not connected");
	}

	if (inputs.subscriptions === "not-open") {
		reasons.push("roomy-subscriptions: a bridged space's sync is not open");
	}

	const sendRetryAge = sweepAge(
		inputs.lastSendRetrySweepAt,
		inputs.now,
		SEND_RETRY_SWEEP_STALE_MS,
		"send-retry-sweep",
		reasons,
	);
	const capacityAge = sweepAge(
		inputs.lastCapacitySweepAt,
		inputs.now,
		CAPACITY_SWEEP_STALE_MS,
		"capacity-sweep",
		reasons,
	);

	return {
		status: reasons.length === 0 ? "ok" : "unhealthy",
		checks: {
			discordGateway: inputs.gatewayConnected ? "connected" : "disconnected",
			roomySubscriptions: inputs.subscriptions,
			sendRetrySweepAgeMs: sendRetryAge,
			capacitySweepAgeMs: capacityAge,
		},
		reasons,
	};
}

/** Age of a sweep, appending a reason when it is missing or too old. */
function sweepAge(
	lastCompletedAt: number | undefined,
	now: number,
	staleAfterMs: number,
	name: string,
	reasons: string[],
): number | null {
	if (lastCompletedAt === undefined) {
		reasons.push(`${name}: never completed`);
		return null;
	}
	// A wall clock that moved backwards is not evidence of staleness; treat a
	// negative age as 0 so an NTP correction cannot restart a healthy bridge.
	const age = Math.max(0, now - lastCompletedAt);
	if (age > staleAfterMs) {
		reasons.push(`${name}: stale (last completed ${age}ms ago)`);
	}
	return age;
}

/** The worker's own liveness sources, read at report time. */
export interface BridgeHealthSources {
	/** True when at least one shard exists and every shard is connected. */
	gatewayConnected(): boolean;
	/** Aggregate state of the per-space Roomy sync subscriptions. */
	subscriptions(): SubscriptionState;
}

/** Records sweep completions and reports them against live socket state. */
export class BridgeHealth {
	readonly #sources: BridgeHealthSources;
	#lastSendRetrySweepAt: number | undefined;
	#lastCapacitySweepAt: number | undefined;

	constructor(sources: BridgeHealthSources) {
		this.#sources = sources;
	}

	/** Called by the one-minute re-offer interval after a sweep actually ran. */
	noteSendRetrySweepCompleted(at: number = Date.now()): void {
		this.#lastSendRetrySweepAt = at;
	}

	/** Called by the five-minute capacity interval after a sweep completed. */
	noteCapacitySweepCompleted(at: number = Date.now()): void {
		this.#lastCapacitySweepAt = at;
	}

	report(now: number = Date.now()): HealthReport {
		return evaluateHealth({
			now,
			gatewayConnected: this.#sources.gatewayConnected(),
			subscriptions: this.#sources.subscriptions(),
			lastSendRetrySweepAt: this.#lastSendRetrySweepAt,
			lastCapacitySweepAt: this.#lastCapacitySweepAt,
		});
	}
}
