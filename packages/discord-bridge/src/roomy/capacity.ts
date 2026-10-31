/**
 * Per-guild capacity enforcement for bridged spaces (Roomy Pro bridge
 * tokens).
 *
 * The bridge queries `space.roomy.admin.getSpaceMembership` (appserver) with
 * the bridged guild's current member count. The appserver answers whether
 * the space is over its token capacity.
 *
 * Enforcement policy (two thresholds):
 * - Over the capacity threshold (`overLimit`, memberCount > maxMembers):
 *   sync CONTINUES, but admins are notified (system message) — the bridge is
 *   at risk, not yet paused.
 * - At the hard-stop threshold (`hardStop`, memberCount >= 2x maxMembers):
 *   ALL sync for that (guild, space) tuple halts and resumes automatically
 *   once a later check finds the member count back under 2x capacity.
 *
 * Decision caching: one decision per (guild, space) with a 300s TTL. The
 * gate path (message ingestion, room creation, profile sync) hits the cache;
 * the sweep and member-change triggers force a refresh.
 *
 * Failure semantics (fail-safe, never fail-closed on transient errors):
 * - `stale` response (Polar unreachable, appserver served cached state):
 *   keep the previous decision.
 * - XRPC error (network, 401/403, 404): keep the previous decision.
 * - Member count unavailable: keep the previous decision.
 * - No previous decision in any of those cases: fall back to enabled
 *   (fail-open) and log — a transient error must not halt a healthy bridge.
 * - 503 (billing not configured): treated as enabled — there is no capacity
 *   to enforce.
 *
 * Fail-open observability (grant-less spaces): a space that is over its
 * capacity but has no bridge-token grants has nothing to enforce, so the
 * bridge fails open (see the branch in `check`). The grant set only changes
 * when a grant ships, so that condition is logged on state transition —
 * once when a (guild, space) tuple enters the fail-open state and once when
 * it leaves — instead of on every ~5-minute sweep. The steady state stays
 * queryable through a single throttled summary line naming every tuple
 * currently failing open: at most one per summary interval for the whole
 * process, regardless of how many tuples or sweeps there are.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("capacity");

/** Default decision cache TTL: 300s per the capacity contract. */
export const CAPACITY_TTL_MS = 300_000;

/** How often the process-wide "tuples failing open" summary line may be
 *  emitted: 1h. One line per interval regardless of how many (guild, space)
 *  tuples are failing open or how often the sweep runs. */
export const FAIL_OPEN_SUMMARY_INTERVAL_MS = 3_600_000;

/** Multiplier of maxMembers at which bridging is hard-stopped. */
export const HARD_STOP_MULTIPLIER = 2;

export type TokenStatus = "pending" | "spent";

export interface SpaceMembershipToken {
	grantorDid: string;
	capacity: number;
	status: TokenStatus;
	live: boolean;
}

/** Response shape of `space.roomy.admin.getSpaceMembership`. */
export interface SpaceMembership {
	spaceDid: string;
	tokens: SpaceMembershipToken[];
	validTokenCount: number;
	maxMembers: number;
	memberCount: number;
	overLimit: boolean;
	stale: boolean;
	checkedAt: number;
}

/** A cached/derived decision for one (guild, space) tuple. */
export interface CapacityDecision {
	guildId: string;
	spaceDid: string;
	memberCount: number;
	maxMembers: number;
	overLimit: boolean;
	/** Derived: memberCount >= 2x maxMembers while over the limit — the
	 *  hard-stop threshold at which bridging is actually halted. */
	hardStop: boolean;
	stale: boolean;
	checkedAt: number;
	/** Derived: sync is allowed for this tuple. */
	enabled: boolean;
}

/** Why a member-count lookup produced no number. */
export interface MemberCountFailure {
	/** HTTP status of the failed Discord request, when the error carried one. */
	status?: number;
	/** Discord JSON error code (e.g. 10004 Unknown Guild), when present. */
	code?: number;
	/** Discord-side description, when present. Truncated for logging. */
	message?: string;
	/** True when retrying cannot succeed without an operator change — the
	 *  guild is unknown (bot removed or kicked) or the bot lacks access. */
	permanent: boolean;
}

export type MemberCountLookup =
	| { ok: true; count: number }
	| { ok: false; failure: MemberCountFailure };

/** Supplies the bridged guild's current member count. */
export interface MemberCountProvider {
	getMemberCount(guildId: string): Promise<MemberCountLookup>;
}

/** Queries the appserver for space membership. */
export interface MembershipClient {
	getSpaceMembership(
		spaceId: string,
		memberCount: number,
	): Promise<SpaceMembership>;
}

/** Gate consulted by sync paths; never throws. */
export interface CapacityGate {
	isEnabled(guildId: string, spaceDid: string): Promise<boolean>;
}

// ─── Module-level gate ──────────────────────────────────────────────────
//
// Sync services (message-ingestion, room-sync, profile-sync, backfill) read
// the gate through getCapacityGate() so their signatures stay unchanged and
// existing tests keep passing with the default always-enabled gate. index.ts
// installs the live CapacityService; tests install a mock.

const ALWAYS_ENABLED: CapacityGate = { isEnabled: async () => true };

let activeGate: CapacityGate = ALWAYS_ENABLED;

export function setCapacityGate(gate: CapacityGate): void {
	activeGate = gate;
}

export function getCapacityGate(): CapacityGate {
	return activeGate;
}

/** Restore the default always-enabled gate. Test-only. */
export function resetCapacityGate(): void {
	activeGate = ALWAYS_ENABLED;
}

// ─── Service ───────────────────────────────────────────────────────────

export interface CapacityServiceOptions {
	/** Decision cache TTL in ms. Default 300s. */
	ttlMs?: number;
	/** Minimum interval between process-wide "tuples failing open" summary
	 *  lines, in ms. Default 1h. Transitions are never throttled; only the
	 *  steady-state reminder is. */
	failOpenSummaryIntervalMs?: number;
	/** Ops kill switch (BRIDGE_CAPACITY_KILL_SWITCH): when true, capacity
	 *  enforcement is disabled globally — every (guild, space) passes.
	 *  Emergency manual re-enable; no XRPC checks are performed. */
	killSwitch?: boolean;
	/** Called on every decision whose `enabled` differs from the previous
	 *  decision (including the first decision for a tuple). Used for the
	 *  owner DM and structured state-change logging. */
	onStateChange?: (
		decision: CapacityDecision,
		previous: CapacityDecision | undefined,
	) => void;
	/** Called whenever the usage state changes: the bridge crossing over
	 *  the capacity threshold (`overLimit` flips) or crossing the hard-stop
	 *  threshold (`hardStop` flips), including the first decision for a
	 *  tuple. Used for the admin system-channel notification. */
	onUsageChange?: (
		decision: CapacityDecision,
		previous: CapacityDecision | undefined,
	) => void;
}

export class CapacityService implements CapacityGate {
	#client: MembershipClient;
	#memberCount: MemberCountProvider;
	#ttlMs: number;
	#failOpenSummaryIntervalMs: number;
	#killSwitch: boolean;
	#killSwitchLogged = false;
	#onStateChange?: CapacityServiceOptions["onStateChange"];
	#onUsageChange?: CapacityServiceOptions["onUsageChange"];
	#cache = new Map<
		string,
		{ decision: CapacityDecision; expiresAt: number }
	>();
	/** (guild, space) tuples currently in the grant-less fail-open state.
	 *  Drives transition logging: a tuple enters on the first sweep that sees
	 *  `overLimit && no grants` and leaves when the grant set changes (or the
	 *  space stops being over its limit). */
	#failOpen = new Map<string, { guildId: string; spaceDid: string }>();
	/** Timestamp of the last steady-state summary line (process-wide). */
	#lastFailOpenSummaryAt = 0;
	/** Guilds whose member-count lookup is currently failing. Gate checks
	 *  keep serving the cached decision and skip Discord; a forced check
	 *  (the periodic sweep) is the only path that retries. */
	#memberCountOutage = new Map<
		string,
		MemberCountFailure & { since: number }
	>();

	constructor(
		client: MembershipClient,
		memberCount: MemberCountProvider,
		opts: CapacityServiceOptions = {},
	) {
		this.#client = client;
		this.#memberCount = memberCount;
		this.#ttlMs = opts.ttlMs ?? CAPACITY_TTL_MS;
		this.#failOpenSummaryIntervalMs =
			opts.failOpenSummaryIntervalMs ?? FAIL_OPEN_SUMMARY_INTERVAL_MS;
		this.#killSwitch = opts.killSwitch ?? false;
		this.#onStateChange = opts.onStateChange;
		this.#onUsageChange = opts.onUsageChange;
	}

	/**
	 * Resolve the current decision for (guild, space). Returns the cached
	 * decision when fresh; otherwise queries the member count and the
	 * appserver. `force` bypasses the cache (used by the periodic sweep and
	 * member-change triggers) and is the only path that retries a failing
	 * member-count lookup. Never throws.
	 */
	async check(
		guildId: string,
		spaceDid: string,
		opts: { force?: boolean } = {},
	): Promise<CapacityDecision> {
		if (this.#killSwitch) {
			if (!this.#killSwitchLogged) {
				this.#killSwitchLogged = true;
				log.warn(
					"capacity: BRIDGE_CAPACITY_KILL_SWITCH is set — capacity enforcement disabled globally; every bridged space passes",
				);
			}
			return {
				guildId,
				spaceDid,
				memberCount: 0,
				maxMembers: 0,
				overLimit: false,
				hardStop: false,
				stale: false,
				checkedAt: Date.now(),
				enabled: true,
			};
		}

		const key = `${guildId}:${spaceDid}`;
		const cached = this.#cache.get(key);
		if (!opts.force && cached && cached.expiresAt > Date.now()) {
			return cached.decision;
		}

		// A failed lookup (Discord refusing or unreachable) is recorded per
		// guild. Gate consultations keep the previous decision — fail-open /
		// fail-closed semantics are unchanged — and do not re-query Discord;
		// only the sweep's forced check retries. Re-storing the decision
		// keeps a gate check inside the TTL off the network entirely.
		if (!opts.force && this.#memberCountOutage.has(guildId)) {
			return cached
				? this.#storeDecision(guildId, spaceDid, cached.decision)
				: this.#store(
						guildId,
						spaceDid,
						fallbackDecision(guildId, spaceDid, "member count unavailable"),
					);
		}

		const lookup = await this.#memberCount.getMemberCount(guildId);
		if (!lookup.ok) {
			this.#noteMemberCountFailure(guildId, lookup.failure);
			log.warn(
				`capacity: member count unavailable for guild ${guildId}; keeping previous decision`,
				{
					guildId,
					spaceDid,
					status: lookup.failure.status,
					discordCode: lookup.failure.code,
					permanent: lookup.failure.permanent,
				},
			);
			return cached
				? this.#storeDecision(guildId, spaceDid, cached.decision)
				: this.#store(
						guildId,
						spaceDid,
						fallbackDecision(guildId, spaceDid, "member count unavailable"),
					);
		}
		this.#noteMemberCountRecovered(guildId);
		const memberCount = lookup.count;

		let membership: SpaceMembership;
		try {
			membership = await this.#client.getSpaceMembership(
				spaceDid,
				memberCount,
			);
		} catch (err) {
			log.warn(
				`capacity: getSpaceMembership failed for ${spaceDid}; keeping previous decision`,
				{ guildId, spaceDid, error: String(err) },
			);
			if (cached) {
				return this.#storeDecision(guildId, spaceDid, cached.decision);
			}
			return this.#store(
				guildId,
				spaceDid,
				fallbackDecision(guildId, spaceDid, "membership query failed"),
			);
		}

		// No grants → no capacity provisioned for the space: nothing to
		// enforce. Fail open so bridges set up before Roomy Pro checkout
		// flows existed keep running; enforcement begins as soon as the
		// first grant ships (the periodic sweep re-checks).
		//
		// The grant set changes only when a grant ships, so log the fail-open
		// state on transition rather than on every sweep (see
		// `#noteFailOpen`). The effect on `membership` is unchanged.
		if (membership.overLimit && membership.tokens.length === 0) {
			this.#noteFailOpen(key, guildId, spaceDid, membership.memberCount);
			membership = { ...membership, overLimit: false };
		} else {
			this.#noteFailOpenCleared(key, guildId, spaceDid, membership);
		}

		if (membership.stale) {
			log.warn(
				`capacity: stale membership for ${spaceDid} (Polar unreachable); keeping previous decision`,
				{ guildId, spaceDid, memberCount: membership.memberCount },
			);
			if (cached) {
				return this.#storeDecision(guildId, spaceDid, cached.decision);
			}
			// No previous decision — the appserver's cached state is all we
			// have; use it rather than failing open.
			return this.#store(guildId, spaceDid, membership);
		}

		return this.#store(guildId, spaceDid, membership);
	}

	/** Gate path: true when sync is allowed for (guild, space). Never throws. */
	async isEnabled(guildId: string, spaceDid: string): Promise<boolean> {
		const decision = await this.check(guildId, spaceDid);
		return decision.enabled;
	}

	/**
	 * Record that (guild, space) is in the grant-less fail-open state.
	 * Warns once on entry — a repeated sweep with unchanged state stays
	 * silent — then keeps the steady state observable with at most one
	 * process-wide summary line per summary interval naming every tuple
	 * currently failing open.
	 */
	#noteFailOpen(
		key: string,
		guildId: string,
		spaceDid: string,
		memberCount: number,
	): void {
		const now = Date.now();
		const firstEntry = !this.#failOpen.has(key);
		this.#failOpen.set(key, { guildId, spaceDid });

		if (firstEntry) {
			// Start the summary clock here: the transition line already
			// reports this tuple, so the steady-state reminder only resumes
			// after a full interval.
			this.#lastFailOpenSummaryAt = now;
			log.warn(
				`capacity: ${spaceDid} has no bridge-token grants; no capacity to enforce — failing open`,
				{
					guildId,
					spaceDid,
					memberCount,
					failOpen: true,
					failOpenSince: new Date(now).toISOString(),
				},
			);
			return;
		}

		if (now - this.#lastFailOpenSummaryAt < this.#failOpenSummaryIntervalMs) {
			return;
		}
		this.#lastFailOpenSummaryAt = now;
		log.warn(
			`capacity: ${this.#failOpen.size} (guild, space) ${this.#failOpen.size === 1 ? "pair is" : "pairs are"} failing open — over capacity with no bridge-token grants; still no capacity to enforce`,
			{
				failOpen: true,
				failOpenCount: this.#failOpen.size,
				pairs: [...this.#failOpen.values()],
			},
		);
	}

	/**
	 * Record that (guild, space) left the grant-less fail-open state: a
	 * grant shipped (enforcement now applies) or the space dropped back
	 * under its capacity. Silent for a tuple that is not currently tracked as
	 * failing open, so the sweep cannot flood the log for healthy spaces.
	 */
	#noteFailOpenCleared(
		key: string,
		guildId: string,
		spaceDid: string,
		membership: SpaceMembership,
	): void {
		// A membership query that could not complete (stale = appserver
		// served cached state because Polar was unreachable) is not evidence
		// of a state change; `check` already logs and keeps the previous
		// decision there, so keep the tuple tracked and stay silent.
		if (membership.stale) return;
		if (!this.#failOpen.delete(key)) return;
		log.warn(
			`capacity: ${spaceDid} no longer fails open (guild ${guildId}) — ${
				membership.tokens.length > 0
					? "bridge-token grants are present; capacity enforcement applies"
					: "member count is within the space's capacity"
			}`,
			{
				guildId,
				spaceDid,
				memberCount: membership.memberCount,
				maxMembers: membership.maxMembers,
				overLimit: membership.overLimit,
				grantCount: membership.tokens.length,
				failOpen: false,
			},
		);
	}

	/**
	 * Record that this guild's member-count lookup is failing. Gate checks
	 * stop probing Discord and keep serving the cached decision; the sweep's
	 * forced check retries. A permanent refusal (unknown guild, missing
	 * access) is reported once on entry so a kicked bot does not flood the
	 * log per message.
	 */
	#noteMemberCountFailure(guildId: string, failure: MemberCountFailure): void {
		const previous = this.#memberCountOutage.get(guildId);
		const since = previous?.since ?? Date.now();
		this.#memberCountOutage.set(guildId, { ...failure, since });
		if (!failure.permanent || previous?.permanent) return;
		log.warn(
			`capacity: member count for guild ${guildId} is permanently unavailable (Discord status ${failure.status ?? "unknown"}${
				failure.code === undefined ? "" : `, code ${failure.code}`
			}); keeping previous decisions and retrying only on forced checks until the guild is reachable again`,
			{
				guildId,
				status: failure.status,
				discordCode: failure.code,
				discordMessage: failure.message,
				permanent: true,
				degraded: "member-count-unavailable",
				degradedSince: new Date(since).toISOString(),
			},
		);
	}

	/** Clear the guild's member-count outage after a successful lookup. */
	#noteMemberCountRecovered(guildId: string): void {
		const outage = this.#memberCountOutage.get(guildId);
		if (!outage) return;
		this.#memberCountOutage.delete(guildId);
		if (!outage.permanent) return;
		log.info(
			`capacity: member count for guild ${guildId} is available again (was Discord status ${outage.status ?? "unknown"}); leaving degraded state`,
			{
				guildId,
				status: outage.status,
				discordCode: outage.code,
				permanent: false,
				degraded: false,
			},
		);
	}

	/** Re-store an unchanged decision with a fresh TTL, so a failed lookup
	 *  cannot turn every gate consultation into a network call. */
	#storeDecision(
		guildId: string,
		spaceDid: string,
		decision: CapacityDecision,
	): CapacityDecision {
		this.#cache.set(`${guildId}:${spaceDid}`, {
			decision,
			expiresAt: Date.now() + this.#ttlMs,
		});
		return decision;
	}

	#store(
		guildId: string,
		spaceDid: string,
		membership: SpaceMembership,
	): CapacityDecision {
		// Hard-stop only when the appserver reports over the limit AND the
		// member count reaches 2x capacity. Under the limit (or fail-open —
		// no grants, kill switch, transient errors) hardStop is never set,
		// so the pre-existing fail-open/fail-safe semantics are preserved.
		const hardStop =
			membership.overLimit &&
			membership.memberCount >= HARD_STOP_MULTIPLIER * membership.maxMembers;
		const decision: CapacityDecision = {
			guildId,
			spaceDid,
			memberCount: membership.memberCount,
			maxMembers: membership.maxMembers,
			overLimit: membership.overLimit,
			hardStop,
			stale: membership.stale,
			checkedAt: membership.checkedAt,
			enabled: !hardStop,
		};
		const key = `${guildId}:${spaceDid}`;
		const previous = this.#cache.get(key)?.decision;
		this.#cache.set(key, {
			decision,
			expiresAt: Date.now() + this.#ttlMs,
		});

		if (!previous || previous.enabled !== decision.enabled) {
			log.info(
				`capacity: ${decision.enabled ? "enabled" : "disabled"} sync for ${spaceDid} (guild ${guildId})`,
				{
					guildId,
					spaceDid,
					enabled: decision.enabled,
					memberCount: decision.memberCount,
					maxMembers: decision.maxMembers,
					overLimit: decision.overLimit,
					hardStop: decision.hardStop,
				},
			);
			try {
				this.#onStateChange?.(decision, previous);
			} catch (err) {
				log.error(
					`capacity: state-change callback failed for ${spaceDid} (guild ${guildId})`,
					err,
				);
			}
		}

		if (
			decision.overLimit !== (previous?.overLimit ?? false) ||
			decision.hardStop !== (previous?.hardStop ?? false)
		) {
			try {
				this.#onUsageChange?.(decision, previous);
			} catch (err) {
				log.error(
					`capacity: usage-change callback failed for ${spaceDid} (guild ${guildId})`,
					err,
				);
			}
		}
		return decision;
	}
}

/** Fail-open decision used when no previous decision exists and the check
 *  could not complete (member count unavailable or XRPC failure). */
function fallbackDecision(
	guildId: string,
	spaceDid: string,
	reason: string,
): SpaceMembership {
	log.warn(
		`capacity: no previous decision for ${spaceDid} (guild ${guildId}); failing open (${reason})`,
		{ guildId, spaceDid, reason },
	);
	return {
		spaceDid,
		tokens: [],
		validTokenCount: 0,
		maxMembers: 0,
		memberCount: 0,
		overLimit: false,
		stale: false,
		checkedAt: Date.now(),
	};
}
