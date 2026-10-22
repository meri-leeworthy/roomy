/**
 * Tests for the HTTP status surface.
 *
 * Covers: APIS01–APIS02 — /sends/failed reports the durable failed-send queue,
 * so an operator can see the sends the bridge still owes a space and which it
 * gave up on. APIS03–APIS18 — every route requires a service-auth caller, and
 * every route that returns space data requires admin standing in the space(s)
 * it returns. APIS19–APIS21 — /sends/replay puts an abandoned entry back in
 * that queue, and does so only for a caller with standing in the entry's space.
 *
 * The token→DID mapping here is a stub: JWT signature and audience checks are
 * covered by `@roomy/service-auth`'s own tests. These tests exercise what the
 * bridge does with a DID once it has one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ApiAuth, type ApiServer, startApi } from "../api.ts";
import { BridgeRepository } from "../db/repository.ts";
import { SPACE_A, SPACE_B } from "../services/__tests__/helpers/test-data.ts";

const GUILD_A = "guild-a";
const GUILD_B = "guild-b";
const ADMIN_DID = "did:plc:admin";
const OUTSIDER_DID = "did:plc:outsider";
const BRIDGE_DID = "did:web:bridge.test";

let repo: BridgeRepository;
let server: ApiServer;
let origPort: string | undefined;
let origBridgeDid: string | undefined;
/** Spaces each DID administers; tests reassign this. */
let adminSpaces: Record<string, string[]>;

/** Every route the API serves. */
const ROUTES = [
	"/info",
	`/get-guild-id?spaceId=${SPACE_A}`,
	`/get-space-id?guildId=${GUILD_A}`,
	"/bridges",
	`/backfill/progress?spaceDid=${SPACE_A}`,
	`/sends/failed?spaceDid=${SPACE_A}`,
	"/sends/replay",
] as const;

/** Queue one entry for a space, optionally already abandoned. */
function queue(spaceDid: string, discordId: string, terminal = false): void {
	repo.enqueueFailedSend({
		spaceDid,
		op: "message_create",
		discordId,
		mappingKind: "message",
		mappingValue: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		eventJson: '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
		error: "XRPC space.roomy.space.sendEvents timed out after 20000ms",
		attempts: 1,
		nextRetryAt: Date.now(),
	});
	if (terminal) {
		const entry = repo
			.listFailedSends()
			.find(
				(send) => send.spaceDid === spaceDid && send.discordId === discordId,
			);
		if (entry) repo.markFailedSendTerminal(entry.id, "gave up");
	}
}

/** The /sends/failed response body. */
type FailedSendsPayload = {
	pending: number;
	terminal: number;
	sends: Record<string, unknown>[];
};

function isFailedSendsPayload(value: unknown): value is FailedSendsPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"pending" in value &&
		typeof value.pending === "number" &&
		"terminal" in value &&
		typeof value.terminal === "number" &&
		"sends" in value &&
		Array.isArray(value.sends)
	);
}

function isBridgesPayload(value: unknown): value is { bridges: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"bridges" in value &&
		Array.isArray(value.bridges)
	);
}

function isChannelsPayload(value: unknown): value is { channels: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"channels" in value &&
		Array.isArray(value.channels)
	);
}

async function getFailedSends(query: string): Promise<FailedSendsPayload> {
	const body = await getJson(`/sends/failed${query}`, ADMIN_DID);
	if (!isFailedSendsPayload(body)) {
		throw new Error(
			`unexpected /sends/failed payload: ${JSON.stringify(body)}`,
		);
	}
	return body;
}

/** GET a route as `did`; omitting it sends no credentials. */
function get(path: string, did?: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${server.port}${path}`, {
		headers: did ? { authorization: `Bearer ${did}` } : {},
	});
}

/** GET a route as `did`, expecting a 200 and returning the parsed body. */
async function getJson(path: string, did: string): Promise<unknown> {
	const res = await get(path, did);
	expect(res.status).toBe(200);
	return res.json();
}

beforeEach(() => {
	origPort = process.env.PORT;
	origBridgeDid = process.env.ATPROTO_BRIDGE_DID;
	// Port 0 lets the OS pick a free port, so the test never fights a running
	// bridge instance.
	process.env.PORT = "0";
	process.env.ATPROTO_BRIDGE_DID = BRIDGE_DID;
	repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD_A, SPACE_A, "full");
	repo.upsertBridgeConfig(GUILD_B, SPACE_B, "full");
	adminSpaces = { [ADMIN_DID]: [SPACE_A] };

	const auth: ApiAuth = {
		verifyRequest: async (req) => {
			const header = req.headers.get("authorization");
			const did = header?.startsWith("Bearer ") ? header.slice(7) : "";
			const known = did === ADMIN_DID || did === OUTSIDER_DID;
			return { did: known ? did : null };
		},
		isSpaceAdmin: async (spaceDid, did) =>
			(adminSpaces[did] ?? []).includes(spaceDid),
	};
	server = startApi(repo, () => "app-1", auth);
});

afterEach(() => {
	server.stop(true);
	if (origPort === undefined) delete process.env.PORT;
	else process.env.PORT = origPort;
	if (origBridgeDid === undefined) delete process.env.ATPROTO_BRIDGE_DID;
	else process.env.ATPROTO_BRIDGE_DID = origBridgeDid;
});

describe("authentication gate", () => {
	// APIS03
	for (const path of ROUTES) {
		test(`APIS03: ${path} answers 401 without credentials`, async () => {
			const res = await get(path);
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({
				error: "Authentication required",
			});
		});
	}

	// APIS04
	test("APIS04: an unverifiable token is unauthenticated, not anonymous-allowed", async () => {
		const res = await get("/bridges", "did:plc:not-a-known-token");
		expect(res.status).toBe(401);
	});

	// APIS05 — the gate runs before routing: a path the router has never heard
	// of is still 401 to an unauthenticated caller, so a route added later
	// cannot be served unauthenticated by omission.
	test("APIS05: an unknown path is 401 without credentials and 404 with them", async () => {
		expect((await get("/not-a-route")).status).toBe(401);
		expect((await get("/not-a-route", ADMIN_DID)).status).toBe(404);
	});

	// APIS06
	test("APIS06: CORS preflight stays unauthenticated and allows Authorization", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/bridges`, {
			method: "OPTIONS",
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-headers")).toContain(
			"Authorization",
		);
	});
});

describe("space standing", () => {
	// APIS07
	test("APIS07: /info needs authentication but no space standing", async () => {
		expect(await getJson("/info", OUTSIDER_DID)).toEqual({
			discordAppId: "app-1",
			bridgeDid: BRIDGE_DID,
		});
	});

	// APIS08
	test("APIS08: /get-guild-id succeeds for an admin of the named space", async () => {
		expect(
			await getJson(`/get-guild-id?spaceId=${SPACE_A}`, ADMIN_DID),
		).toEqual({ guildId: GUILD_A });
	});

	// APIS09
	test("APIS09: /get-guild-id rejects a caller without standing in the named space", async () => {
		const res = await get(`/get-guild-id?spaceId=${SPACE_A}`, OUTSIDER_DID);
		expect(res.status).toBe(403);
	});

	// APIS10
	test("APIS10: /get-space-id succeeds for an admin of the guild's spaces", async () => {
		expect(
			await getJson(`/get-space-id?guildId=${GUILD_A}`, ADMIN_DID),
		).toEqual({
			spaceIds: [SPACE_A],
		});
	});

	// APIS11
	test("APIS11: /get-space-id rejects a caller who does not administer the guild's space", async () => {
		const res = await get(`/get-space-id?guildId=${GUILD_A}`, OUTSIDER_DID);
		expect(res.status).toBe(403);
	});

	// APIS12
	test("APIS12: /bridges with a guild filter succeeds for an admin of that guild's spaces", async () => {
		const body = await getJson(`/bridges?guildId=${GUILD_A}`, ADMIN_DID);
		expect(body).toEqual({
			bridges: [
				{
					guildId: GUILD_A,
					spaceDid: SPACE_A,
					mode: "full",
					createdAt: expect.any(Number),
					updatedAt: expect.any(Number),
				},
			],
		});
	});

	// APIS13 — the unfiltered form is operator-only: it is served only to a
	// caller who administers every space it would return.
	test("APIS13: unfiltered /bridges is 403 for an admin of only some bridged spaces", async () => {
		const res = await get("/bridges", ADMIN_DID);
		expect(res.status).toBe(403);
	});

	// APIS14
	test("APIS14: unfiltered /bridges is 200 for a caller who administers every bridged space", async () => {
		adminSpaces = { [ADMIN_DID]: [SPACE_A, SPACE_B] };
		const body = await getJson("/bridges", ADMIN_DID);
		if (!isBridgesPayload(body)) {
			throw new Error(`unexpected /bridges payload: ${JSON.stringify(body)}`);
		}
		expect(body.bridges.length).toBe(2);
	});

	// APIS15
	test("APIS15: /backfill/progress requires standing in the named space even when it has no rows", async () => {
		const res = await get(
			`/backfill/progress?spaceDid=${SPACE_A}`,
			OUTSIDER_DID,
		);
		expect(res.status).toBe(403);
	});

	// APIS16
	test("APIS16: /backfill/progress succeeds for an admin of the named space", async () => {
		repo.upsertBackfillProgress({
			spaceDid: SPACE_A,
			channelId: "chan-1",
			guildId: GUILD_A,
			kind: "channel",
			channelName: "general",
			phase: "phase2",
			messagesSynced: 10,
			messagesSkipped: 0,
		});
		const body = await getJson(
			`/backfill/progress?spaceDid=${SPACE_A}`,
			ADMIN_DID,
		);
		if (!isChannelsPayload(body)) {
			throw new Error(
				`unexpected /backfill/progress payload: ${JSON.stringify(body)}`,
			);
		}
		expect(body.channels.length).toBe(1);
	});

	// APIS17
	test("APIS17: /sends/failed rejects a caller without standing in the named space", async () => {
		queue(SPACE_A, "42");
		const res = await get(`/sends/failed?spaceDid=${SPACE_A}`, OUTSIDER_DID);
		expect(res.status).toBe(403);
	});

	// APIS18 — unscoped means "every space with failed sends", so the same
	// operator-only rule applies.
	test("APIS18: unscoped /sends/failed is 403 unless the caller administers every space in the queue", async () => {
		queue(SPACE_A, "42");
		queue(SPACE_B, "44");
		expect((await get("/sends/failed", ADMIN_DID)).status).toBe(403);

		adminSpaces = { [ADMIN_DID]: [SPACE_A, SPACE_B] };
		expect((await get("/sends/failed", ADMIN_DID)).status).toBe(200);
	});
});

describe("/sends/failed", () => {
	// APIS01
	test("APIS01: reports queue depth and entries for one space, without event payloads", async () => {
		queue(SPACE_A, "42");
		queue(SPACE_A, "43", true);
		queue(SPACE_B, "44");

		const body = await getFailedSends(`?spaceDid=${SPACE_A}`);

		expect(body.pending).toBe(1);
		expect(body.terminal).toBe(1);
		expect(body.sends.length).toBe(2);
		const entry = body.sends.find((send) => send.discordId === "42");
		expect(entry?.op).toBe("message_create");
		expect(entry?.attempts).toBe(1);
		expect(entry?.lastError).toContain("timed out");
		// The payload is internal: this is a status read. `id` is the handle
		// /sends/replay takes.
		expect(entry?.eventJson).toBeUndefined();
		expect(entry?.mappingValue).toBeUndefined();
		expect(typeof entry?.id).toBe("number");
	});

	// APIS02
	test("APIS02: counts every space when unscoped", async () => {
		queue(SPACE_A, "42");
		queue(SPACE_B, "44");
		adminSpaces = { [ADMIN_DID]: [SPACE_A, SPACE_B] };

		const body = await getFailedSends("");

		expect(body.pending).toBe(2);
		expect(body.sends.length).toBe(2);
	});
});

/** The /sends/replay response body. */
type ReplayPayload = { replayed: Record<string, unknown> };

/**
 * Replay one entry by id as `did`; `init` overrides the POST for the refusal
 * cases.
 */
async function replaySend(
	query: string,
	init: RequestInit = { method: "POST" },
	did: string = ADMIN_DID,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${server.port}/sends/replay${query}`, {
		...init,
		headers: { authorization: `Bearer ${did}` },
	});
}

describe("/sends/replay", () => {
	// APIS19
	test("APIS19: replaying an abandoned entry requeues the same payload", async () => {
		queue(SPACE_A, "42", true);

		const listed = await getFailedSends(`?spaceDid=${SPACE_A}`);
		const id = listed.sends[0]?.id;
		expect(typeof id).toBe("number");

		const res = await replaySend(`?id=${String(id)}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ReplayPayload;
		expect(body.replayed.attempts).toBe(0);
		expect(body.replayed.terminal).toBe(false);
		expect(typeof body.replayed.nextRetryAt).toBe("number");
		// The payload stays out of the response; only the queue state moves.
		expect(body.replayed.eventJson).toBeUndefined();

		const after = await getFailedSends(`?spaceDid=${SPACE_A}`);
		expect(after.pending).toBe(1);
		expect(after.terminal).toBe(0);
	});

	// APIS20
	test("APIS20: an unknown id, a missing id and a non-POST are refused", async () => {
		expect((await replaySend("?id=999")).status).toBe(404);
		expect((await replaySend("")).status).toBe(400);
		expect((await replaySend("?id=abc")).status).toBe(400);
		expect((await replaySend("?id=1", { method: "GET" })).status).toBe(405);
	});

	// APIS21 — the space is checked before the row is reset, so a refused
	// caller neither replays the entry nor learns it was requeued.
	test("APIS21: replay is 403 without standing in the entry's space, and leaves the entry abandoned", async () => {
		queue(SPACE_A, "42", true);
		const listed = await getFailedSends(`?spaceDid=${SPACE_A}`);
		const id = listed.sends[0]?.id;
		expect(typeof id).toBe("number");

		const res = await replaySend(
			`?id=${String(id)}`,
			{ method: "POST" },
			OUTSIDER_DID,
		);
		expect(res.status).toBe(403);

		const after = await getFailedSends(`?spaceDid=${SPACE_A}`);
		expect(after.pending).toBe(0);
		expect(after.terminal).toBe(1);
	});
});
