/**
 * Tests for the worker liveness state machine behind `GET /health`.
 *
 * The state is what the worker last observed: socket state read at report
 * time, and sweep completion timestamps recorded by the sweep timers. The
 * point of these tests is that a listening process is not enough — every
 * input that means "the worker stopped doing its job" turns the report
 * unhealthy and names the component.
 */

import { describe, expect, test } from "bun:test";
import {
	BridgeHealth,
	CAPACITY_SWEEP_STALE_MS,
	evaluateHealth,
	type HealthInputs,
	SEND_RETRY_SWEEP_STALE_MS,
	type SubscriptionState,
} from "../health.ts";

const NOW = 1_800_000_000_000;

/** Inputs for a live worker; each test overrides the one it cares about. */
function liveInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
	return {
		now: NOW,
		gatewayConnected: true,
		subscriptions: "idle",
		lastSendRetrySweepAt: NOW - 10_000,
		lastCapacitySweepAt: NOW - 60_000,
		...overrides,
	};
}

describe("evaluateHealth", () => {
	test("HLTH01: live worker reports ok with both sweep ages", () => {
		const report = evaluateHealth(liveInputs());

		expect(report.status).toBe("ok");
		expect(report.reasons).toEqual([]);
		expect(report.checks).toEqual({
			discordGateway: "connected",
			roomySubscriptions: "idle",
			sendRetrySweepAgeMs: 10_000,
			capacitySweepAgeMs: 60_000,
		});
	});

	test("HLTH02: a send-retry sweep older than its threshold is stale", () => {
		const report = evaluateHealth(
			liveInputs({
				lastSendRetrySweepAt: NOW - SEND_RETRY_SWEEP_STALE_MS - 1,
			}),
		);

		expect(report.status).toBe("unhealthy");
		expect(report.reasons).toHaveLength(1);
		expect(report.reasons[0]).toContain("send-retry-sweep: stale");
		expect(report.reasons[0]).toContain(
			`${SEND_RETRY_SWEEP_STALE_MS + 1}ms ago`,
		);
	});

	test("HLTH03: a capacity sweep older than its threshold is stale", () => {
		const report = evaluateHealth(
			liveInputs({
				lastCapacitySweepAt: NOW - CAPACITY_SWEEP_STALE_MS - 1,
			}),
		);

		expect(report.status).toBe("unhealthy");
		expect(report.reasons).toHaveLength(1);
		expect(report.reasons[0]).toContain("capacity-sweep: stale");
	});

	test("HLTH04: a sweep exactly at the threshold is still allowed", () => {
		const report = evaluateHealth(
			liveInputs({
				lastSendRetrySweepAt: NOW - SEND_RETRY_SWEEP_STALE_MS,
				lastCapacitySweepAt: NOW - CAPACITY_SWEEP_STALE_MS,
			}),
		);

		expect(report.status).toBe("ok");
	});

	test("HLTH05: a sweep that never completed is named, not silently fresh", () => {
		const report = evaluateHealth(
			liveInputs({
				lastSendRetrySweepAt: undefined,
				lastCapacitySweepAt: undefined,
			}),
		);

		expect(report.status).toBe("unhealthy");
		expect(report.checks.sendRetrySweepAgeMs).toBeNull();
		expect(report.checks.capacitySweepAgeMs).toBeNull();
		expect(report.reasons).toEqual([
			"send-retry-sweep: never completed",
			"capacity-sweep: never completed",
		]);
	});

	test("HLTH06: a disconnected gateway fails the report", () => {
		const report = evaluateHealth(liveInputs({ gatewayConnected: false }));

		expect(report.status).toBe("unhealthy");
		expect(report.checks.discordGateway).toBe("disconnected");
		expect(report.reasons).toEqual(["discord-gateway: not connected"]);
	});

	test("HLTH07: an open subscription set is healthy, a closed one is not", () => {
		const open = evaluateHealth(liveInputs({ subscriptions: "open" }));
		expect(open.status).toBe("ok");
		expect(open.checks.roomySubscriptions).toBe("open");

		const closed = evaluateHealth(liveInputs({ subscriptions: "not-open" }));
		expect(closed.status).toBe("unhealthy");
		expect(closed.reasons).toEqual([
			"roomy-subscriptions: a bridged space's sync is not open",
		]);
	});

	test("HLTH08: a clock that moved backwards does not report a negative age", () => {
		const report = evaluateHealth(
			liveInputs({ lastSendRetrySweepAt: NOW + 5_000 }),
		);

		expect(report.status).toBe("ok");
		expect(report.checks.sendRetrySweepAgeMs).toBe(0);
	});

	test("HLTH09: every failed component is named in one report", () => {
		const report = evaluateHealth({
			now: NOW,
			gatewayConnected: false,
			subscriptions: "not-open",
			lastSendRetrySweepAt: undefined,
			lastCapacitySweepAt: NOW - CAPACITY_SWEEP_STALE_MS - 1,
		});

		expect(report.status).toBe("unhealthy");
		expect(report.reasons).toHaveLength(4);
		expect(report.reasons.join(" | ")).toContain("discord-gateway");
		expect(report.reasons.join(" | ")).toContain("roomy-subscriptions");
		expect(report.reasons.join(" | ")).toContain("send-retry-sweep");
		expect(report.reasons.join(" | ")).toContain("capacity-sweep");
	});
});

describe("BridgeHealth", () => {
	test("HLTH10: reports the sources at call time, after recorded sweeps", () => {
		let gatewayConnected = true;
		let subscriptions: SubscriptionState = "open";
		const health = new BridgeHealth({
			gatewayConnected: () => gatewayConnected,
			subscriptions: () => subscriptions,
		});

		// Before any sweep runs the report is unhealthy; the state does not
		// claim a beat the worker has not produced.
		expect(health.report(NOW).status).toBe("unhealthy");

		health.noteSendRetrySweepCompleted(NOW);
		health.noteCapacitySweepCompleted(NOW);
		expect(health.report(NOW).status).toBe("ok");

		// Socket state is read per report, not cached at construction.
		gatewayConnected = false;
		expect(health.report(NOW).reasons).toContain(
			"discord-gateway: not connected",
		);
		gatewayConnected = true;
		subscriptions = "not-open";
		expect(health.report(NOW).reasons).toContain(
			"roomy-subscriptions: a bridged space's sync is not open",
		);
	});

	test("HLTH11: a stale timestamp turns the report unhealthy at report time", () => {
		const health = new BridgeHealth({
			gatewayConnected: () => true,
			subscriptions: () => "idle",
		});
		health.noteSendRetrySweepCompleted(NOW);
		health.noteCapacitySweepCompleted(NOW);

		expect(health.report(NOW).status).toBe("ok");
		expect(health.report(NOW + SEND_RETRY_SWEEP_STALE_MS + 1).status).toBe(
			"unhealthy",
		);
	});
});
