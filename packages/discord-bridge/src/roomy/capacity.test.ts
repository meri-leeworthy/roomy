/**
 * Unit tests for the capacity decision service (Roomy Pro bridge tokens).
 *
 * Covers: over/under limit decisions, unprovisioned spaces (no grants)
 * failing open, ops kill switch, stale-keeps-previous, TTL expiry,
 * member-count/XRPC failure keeps previous, state-change callback, force
 * refresh, and the module-level gate singleton.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	CAPACITY_TTL_MS,
	CapacityService,
	FAIL_OPEN_SUMMARY_INTERVAL_MS,
	getCapacityGate,
	setCapacityGate,
	type CapacityDecision,
	type MemberCountProvider,
	type MembershipClient,
	type SpaceMembership,
	type SpaceMembershipToken,
} from "./capacity.ts";
import { _setLokiSink } from "../logger.ts";

const GUILD = "guild-1";
const SPACE = "did:web:space-a.example";

function token(over: Partial<SpaceMembershipToken> = {}): SpaceMembershipToken {
	return {
		grantorDid: "did:plc:grantor-1",
		capacity: 100,
		status: "pending",
		live: true,
		...over,
	};
}

function membership(over: Partial<SpaceMembership> = {}): SpaceMembership {
	return {
		spaceDid: SPACE,
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

function makeClient(responses: SpaceMembership[] = []): MembershipClient & {
	calls: Array<{ spaceId: string; memberCount: number }>;
} {
	const calls: Array<{ spaceId: string; memberCount: number }> = [];
	return {
		calls,
		async getSpaceMembership(spaceId, memberCount) {
			calls.push({ spaceId, memberCount });
			const next = responses.shift();
			if (!next) throw new Error("unexpected getSpaceMembership call");
			return next;
		},
	};
}

function makeMemberCount(count: number | undefined): MemberCountProvider & {
	calls: number;
} {
	let calls = 0;
	return {
		calls: 0,
		async getMemberCount() {
			calls++;
			(this as { calls: number }).calls = calls;
			return count;
		},
	};
}

function makeService(
	client: MembershipClient,
	memberCount: MemberCountProvider,
	onStateChange?: (d: CapacityDecision, p: CapacityDecision | undefined) => void,
	onUsageChange?: (d: CapacityDecision, p: CapacityDecision | undefined) => void,
): CapacityService {
	return new CapacityService(client, memberCount, {
		onStateChange,
		onUsageChange,
	});
}

// ─── Capacity log capture ───────────────────────────────────────────────
//
// The capacity service logs through the structured logger. Tests capture
// lines via a mock Loki sink (the same harness the logger tests use) and
// silence the stdout sinks.

interface CapturedLine {
	msg: string;
	[key: string]: unknown;
}

let captured: CapturedLine[] = [];
let consoleSpies: Array<{ mockRestore(): void }> = [];

function startLogCapture(): void {
	captured = [];
	consoleSpies = [
		vi.spyOn(console, "info").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
		vi.spyOn(console, "error").mockImplementation(() => {}),
	];
	_setLokiSink({
		push: (record) => captured.push(JSON.parse(record.line)),
		flush: async () => {},
		stop: () => {},
		stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
	});
}

function stopLogCapture(): void {
	_setLokiSink(null);
	for (const spy of consoleSpies) spy.mockRestore();
	consoleSpies = [];
}

/** Captured capacity lines whose message contains `needle`. */
function logsMatching(needle: string): CapturedLine[] {
	return captured.filter(
		(line) => line.scope === "capacity" && String(line.msg).includes(needle),
	);
}

describe("CapacityService decisions", () => {
	test("over limit but below 2x → still enabled (notify-only)", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(true);
		expect(decision.hardStop).toBe(false);
		expect(decision.memberCount).toBe(150);
		expect(decision.maxMembers).toBe(100);
		expect(client.calls).toEqual([{ spaceId: SPACE, memberCount: 150 }]);
	});

	test("at 2x the limit → disabled (hard stop)", async () => {
		const client = makeClient([
			membership({
				memberCount: 200,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(200));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
		expect(decision.overLimit).toBe(true);
		expect(decision.hardStop).toBe(true);
	});

	test("just under 2x the limit → still enabled", async () => {
		const client = makeClient([
			membership({
				memberCount: 199,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(199));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(true);
		expect(decision.hardStop).toBe(false);
	});

	test("under limit → enabled", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(false);
	});

	test("over limit with no grants fails open (unprovisioned space)", async () => {
		const client = makeClient([
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
		expect(decision.overLimit).toBe(false);

		// The fail-open decision is cached like any other: no re-query.
		await service.check(GUILD, SPACE);
		expect(client.calls.length).toBe(1);
	});

	test("kill switch forces enabled without consulting client or member count", async () => {
		const client = makeClient([]);
		const memberCount = makeMemberCount(150);
		const service = new CapacityService(client, memberCount, {
			killSwitch: true,
		});

		expect(await service.check(GUILD, SPACE)).toMatchObject({
			enabled: true,
		});
		expect(client.calls.length).toBe(0);
		expect(memberCount.calls).toBe(0);
	});

	test("isEnabled reflects the decision", async () => {
		const client = makeClient([
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250));

		expect(await service.isEnabled(GUILD, SPACE)).toBe(false);
	});
});

describe("CapacityService stale handling", () => {
	test("stale keeps previous enabled decision (no hard-stop from stale data)", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				stale: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		// Second check: stale response — keep the previous (enabled) decision,
		// even though the stale data alone would imply a hard stop.
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
		expect(second.overLimit).toBe(false);
		expect(client.calls.length).toBe(2);
	});

	test("stale keeps previous disabled decision", async () => {
		const client = makeClient([
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false, stale: true }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(false);

		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(false);
	});

	test("stale with no previous decision uses the stale data", async () => {
		const client = makeClient([
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				stale: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
		expect(decision.hardStop).toBe(true);
		expect(decision.stale).toBe(true);
	});
});

describe("CapacityService TTL", () => {
	test("cached decision returned within TTL (no re-query)", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		await service.check(GUILD, SPACE);
		const second = await service.check(GUILD, SPACE);

		expect(second.enabled).toBe(true);
		expect(client.calls.length).toBe(1);
	});

	test("re-queries after TTL expiry", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = new CapacityService(client, makeMemberCount(250), {
			ttlMs: 1,
		});

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		await new Promise((r) => setTimeout(r, 5));
		const second = await service.check(GUILD, SPACE);

		expect(second.enabled).toBe(false);
		expect(client.calls.length).toBe(2);
	});

	test("force bypasses the cache", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		await service.check(GUILD, SPACE);
		await service.check(GUILD, SPACE, { force: true });

		expect(client.calls.length).toBe(2);
	});
});

describe("CapacityService failure handling", () => {
	test("member count unavailable keeps previous decision", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		// Mutable count: available for the first check, then unavailable.
		let count: number | undefined = 50;
		const memberCount: MemberCountProvider = {
			async getMemberCount() {
				return count;
			},
		};
		const service = makeService(client, memberCount);

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);
		expect(client.calls.length).toBe(1);

		// Member count now unavailable — keep previous (enabled) decision.
		count = undefined;
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
		expect(client.calls.length).toBe(1);
	});

	test("member count unavailable with no previous decision fails open", async () => {
		const service = makeService(makeClient([]), makeMemberCount(undefined));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
	});

	test("XRPC error keeps previous decision", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50));

		const first = await service.check(GUILD, SPACE);
		expect(first.enabled).toBe(true);

		// Second call: client throws (e.g. 401/403/404/network) — keep previous.
		const failing = makeClient([]);
		failing.getSpaceMembership = async () => {
			throw new Error("XRPC failed (503)");
		};
		const service2 = makeService(failing, makeMemberCount(50));
		// Seed the cache via the first service's decision? No — use the same
		// service instance with a client that starts failing.
		const second = await service.check(GUILD, SPACE, { force: true });
		expect(second.enabled).toBe(true);
	});

	test("XRPC error with no previous decision fails open", async () => {
		const failing = makeClient([]);
		failing.getSpaceMembership = async () => {
			throw new Error("XRPC failed (401)");
		};
		const service = makeService(failing, makeMemberCount(50));

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(true);
	});
});

describe("CapacityService state-change callback", () => {
	let changes: Array<{ enabled: boolean; previous?: boolean }>;

	beforeEach(() => {
		changes = [];
	});

	test("fires on enabled→disabled and disabled→enabled transitions", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(50), (d, p) => {
			changes.push({ enabled: d.enabled, previous: p?.enabled });
		});

		await service.check(GUILD, SPACE); // enabled (first decision)
		await service.check(GUILD, SPACE, { force: true }); // disabled
		await service.check(GUILD, SPACE, { force: true }); // enabled again

		expect(changes).toEqual([
			{ enabled: true, previous: undefined },
			{ enabled: false, previous: true },
			{ enabled: true, previous: false },
		]);
	});

	test("does not fire when the decision is unchanged", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({ memberCount: 60, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(60), (d, p) => {
			changes.push({ enabled: d.enabled, previous: p?.enabled });
		});

		await service.check(GUILD, SPACE);
		await service.check(GUILD, SPACE, { force: true });

		expect(changes).toEqual([{ enabled: true, previous: undefined }]);
	});

	test("callback throw does not break the decision flow", async () => {
		const client = makeClient([
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250), () => {
			throw new Error("callback boom");
		});

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
	});
});

describe("CapacityService usage-change callback", () => {
	let usage: Array<{ overLimit: boolean; hardStop: boolean; prevOver?: boolean; prevHardStop?: boolean }>;

	beforeEach(() => {
		usage = [];
	});

	test("fires on over-limit crossing and on hard-stop crossing", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250), undefined, (d, p) => {
			usage.push({
				overLimit: d.overLimit,
				hardStop: d.hardStop,
				prevOver: p?.overLimit,
				prevHardStop: p?.hardStop,
			});
		});

		await service.check(GUILD, SPACE); // under → no usage state change
		await service.check(GUILD, SPACE, { force: true }); // over 1.5x → notify
		await service.check(GUILD, SPACE, { force: true }); // 2.5x → hard stop

		expect(usage).toEqual([
			{ overLimit: true, hardStop: false, prevOver: false, prevHardStop: false },
			{ overLimit: true, hardStop: true, prevOver: true, prevHardStop: false },
		]);
	});

	test("fires on the first decision when already over the limit", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(150), undefined, (d) => {
			usage.push({ overLimit: d.overLimit, hardStop: d.hardStop });
		});

		const decision = await service.check(GUILD, SPACE);

		expect(usage).toEqual([{ overLimit: true, hardStop: false }]);
		expect(usage.length).toBe(1);
	});

	test("does not fire while over but the usage state is unchanged", async () => {
		const client = makeClient([
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			membership({
				memberCount: 160,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(160), undefined, (d) => {
			usage.push({ overLimit: d.overLimit, hardStop: d.hardStop });
		});

		await service.check(GUILD, SPACE); // first decision → fires once
		await service.check(GUILD, SPACE, { force: true }); // still over 1.6x → no fire

		expect(usage).toEqual([{ overLimit: true, hardStop: false }]);
	});

	test("usage-change callback throw does not break enforcement", async () => {
		const client = makeClient([
			membership({
				memberCount: 250,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
		]);
		const service = makeService(client, makeMemberCount(250), undefined, () => {
			throw new Error("usage boom");
		});

		const decision = await service.check(GUILD, SPACE);

		expect(decision.enabled).toBe(false);
		expect(decision.hardStop).toBe(true);
	});
});

describe("CapacityService fail-open log cadence", () => {
	const NO_GRANTS = "no capacity to enforce";
	const RECOVERED = "no longer fails open";

	beforeEach(() => {
		startLogCapture();
	});

	afterEach(() => {
		stopLogCapture();
	});

	test("repeated sweep with unchanged state emits the warning once", async () => {
		// Three sweeps, identical grant-less over-limit state throughout.
		const client = makeClient([
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		await service.check(GUILD, SPACE, { force: true });
		const afterFirst = logsMatching(NO_GRANTS).length;
		await service.check(GUILD, SPACE, { force: true });
		await service.check(GUILD, SPACE, { force: true });

		expect(client.calls.length).toBe(3);
		expect(afterFirst).toBe(1);
		expect(logsMatching(NO_GRANTS).length).toBe(1);
	});

	test("the entry warning carries the guild, space and fail-open state", async () => {
		const client = makeClient([
			membership({ memberCount: 150, maxMembers: 0, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		await service.check(GUILD, SPACE, { force: true });

		const [entry] = logsMatching(NO_GRANTS);
		expect(entry).toMatchObject({
			guildId: GUILD,
			spaceDid: SPACE,
			memberCount: 150,
			failOpen: true,
		});
	});

	test("emits again when the state changes: grants ship, then are revoked", async () => {
		const client = makeClient([
			// Sweep 1: over limit, no grants → enters fail-open.
			membership({ memberCount: 150, maxMembers: 100, overLimit: true }),
			// Sweep 2: same tuple, still over limit, but a grant now exists.
			membership({
				memberCount: 150,
				maxMembers: 100,
				overLimit: true,
				tokens: [token()],
				validTokenCount: 1,
			}),
			// Sweep 3: grant revoked → fail-open again.
			membership({ memberCount: 150, maxMembers: 100, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		await service.check(GUILD, SPACE, { force: true }); // fail open
		await service.check(GUILD, SPACE, { force: true }); // enforced
		const afterRecovery = logsMatching(RECOVERED).length;
		await service.check(GUILD, SPACE, { force: true }); // fail open again

		expect(afterRecovery).toBe(1);
		expect(logsMatching(NO_GRANTS).length).toBe(2);
		expect(logsMatching(NO_GRANTS)[1]).toMatchObject({
			guildId: GUILD,
			spaceDid: SPACE,
			failOpen: true,
		});
	});

	test("stale membership does not count as a state change", async () => {
		const client = makeClient([
			membership({ memberCount: 150, maxMembers: 100, overLimit: true }),
			// Polar unreachable: appserver serves stale state, over limit with
			// no grants in that stale view. The sweep keeps the previous
			// decision, so this must not re-emit or clear the fail-open state.
			membership({ memberCount: 150, maxMembers: 100, overLimit: true, stale: true }),
			membership({ memberCount: 150, maxMembers: 100, overLimit: true }),
		]);
		const service = makeService(client, makeMemberCount(150));

		await service.check(GUILD, SPACE, { force: true });
		await service.check(GUILD, SPACE, { force: true });
		await service.check(GUILD, SPACE, { force: true });

		expect(logsMatching(NO_GRANTS).length).toBe(1);
		expect(logsMatching(RECOVERED).length).toBe(0);
	});

	test("healthy tuples stay silent even at warn level", async () => {
		const client = makeClient([
			membership({ memberCount: 50, maxMembers: 100, overLimit: false }),
			membership({ memberCount: 60, maxMembers: 100, overLimit: false }),
		]);
		const service = makeService(client, makeMemberCount(60));

		await service.check(GUILD, SPACE, { force: true });
		await service.check(GUILD, SPACE, { force: true });

		expect(logsMatching(NO_GRANTS).length).toBe(0);
		expect(logsMatching(RECOVERED).length).toBe(0);
	});

	test("steady state stays observable: at most one summary line per interval, counting the failing-open pairs", async () => {
		const OTHER_SPACE = "did:web:space-b.example";
		const interval = 50;
		vi.useFakeTimers();
		try {
			const membershipClient = makeClient([]);
			membershipClient.getSpaceMembership = async (spaceId) =>
				membership({
					spaceDid: spaceId,
					memberCount: 150,
					maxMembers: 0,
					overLimit: true,
				});
			const svc = new CapacityService(membershipClient, makeMemberCount(150), {
				failOpenSummaryIntervalMs: interval,
			});

			// Both tuples enter the fail-open state.
			await svc.check(GUILD, SPACE, { force: true });
			await svc.check(GUILD, OTHER_SPACE, { force: true });
			expect(logsMatching(NO_GRANTS).length).toBe(2);

			// A sweep inside the interval stays silent.
			await svc.check(GUILD, SPACE, { force: true });
			expect(logsMatching(NO_GRANTS).length).toBe(2);

			// Interval elapsed → one summary for the whole process naming both
			// pairs; the second tuple's sweep right after is throttled.
			vi.advanceTimersByTime(interval + 1);
			await svc.check(GUILD, SPACE, { force: true });
			await svc.check(GUILD, OTHER_SPACE, { force: true });
			const summaryLines = logsMatching(NO_GRANTS);
			expect(summaryLines.length).toBe(3);
			expect(summaryLines[2]).toMatchObject({
				failOpen: true,
				failOpenCount: 2,
			});
			expect(summaryLines[2]!.pairs).toEqual([
				{ guildId: GUILD, spaceDid: SPACE },
				{ guildId: GUILD, spaceDid: OTHER_SPACE },
			]);

			// Next interval → the steady state is restated once more.
			vi.advanceTimersByTime(interval + 1);
			await svc.check(GUILD, SPACE, { force: true });
			await svc.check(GUILD, OTHER_SPACE, { force: true });
			expect(logsMatching(NO_GRANTS).length).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("CapacityService fail-open summary constant", () => {
	test("summary interval defaults to 1h", () => {
		expect(FAIL_OPEN_SUMMARY_INTERVAL_MS).toBe(3_600_000);
	});
});

describe("capacity gate singleton", () => {
	afterEach(() => {
		setCapacityGate({ isEnabled: async () => true });
	});

	test("default gate is always enabled", async () => {
		expect(await getCapacityGate().isEnabled(GUILD, SPACE)).toBe(true);
	});

	test("setCapacityGate installs a custom gate", async () => {
		const gate = { isEnabled: vi.fn(async () => false) };
		setCapacityGate(gate);

		expect(await getCapacityGate().isEnabled(GUILD, SPACE)).toBe(false);
		expect(gate.isEnabled).toHaveBeenCalledWith(GUILD, SPACE);
	});
});

describe("CapacityService TTL constant", () => {
	test("default TTL is 300s per the contract", () => {
		expect(CAPACITY_TTL_MS).toBe(300_000);
	});
});
