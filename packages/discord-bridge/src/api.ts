import type { BridgeRepository, FailedSend } from "./db/repository.ts";
import { ATPROTO_BRIDGE_DID, PORT } from "./env.ts";
import { createLogger } from "./logger.ts";
import { isBackfillRunning } from "./services/backfill.ts";

const log = createLogger("api");

/** A running status API server, as returned by `startApi`. */
export type ApiServer = Bun.Server<undefined>;

/**
 * Authentication and standing for the status API.
 *
 * `verifyRequest` turns the request's service-auth JWT into a caller DID
 * (`null` when absent or invalid). `isSpaceAdmin` answers the per-space
 * standing question for every route whose response contains space data.
 */
export interface ApiAuth {
	/** Resolve the caller from its service-auth JWT; null when unauthenticated. */
	verifyRequest(req: Request): Promise<{ did: string | null }>;
	/** Whether `did` administers `spaceDid`, per the appserver's member list. */
	isSpaceAdmin(spaceDid: string, did: string): Promise<boolean>;
}

export function startApi(
	repo: BridgeRepository,
	getAppId: () => string | undefined,
	auth: ApiAuth,
): ApiServer {
	const server = Bun.serve({
		port: PORT(),
		async fetch(req) {
			const url = new URL(req.url);

			// CORS preflight carries no credentials by definition, and the
			// browser will not send the request it authorizes until this
			// answer is a 2xx.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}

			let response: Response;
			try {
				// The gate lives here, before routing, so a route added later
				// cannot be served unauthenticated by omission.
				const callerDid = (await auth.verifyRequest(req)).did;
				response =
					callerDid === null
						? jsonResponse({ error: "Authentication required" }, 401)
						: await route(req, url, repo, getAppId, auth, callerDid);
			} catch (err) {
				log.error("API error", err);
				response = jsonResponse({ error: "Internal server error" }, 500);
			}

			for (const [k, v] of Object.entries(corsHeaders())) {
				response.headers.set(k, v);
			}
			return response;
		},
	});

	log.info(`API listening on 0.0.0.0:${server.port}`);
	return server;
}

/**
 * 403 unless `callerDid` administers every space the response would cover.
 *
 * The rule is uniform across routes: a response is served only when the
 * caller has standing in every space it describes. A named space therefore
 * needs one admin edge; a guild- or unfiltered query needs admin in each
 * space it would return. For `/bridges` with no filter that makes the
 * unfiltered form operator-only — a caller administering every bridged space
 * — rather than refusing it outright, so the operator's existing call keeps
 * working and no route needs a special "unfiltered is forbidden" case.
 */
async function requireAdmin(
	auth: ApiAuth,
	callerDid: string,
	spaceDids: readonly string[],
): Promise<Response | null> {
	for (const spaceDid of new Set(spaceDids)) {
		if (!(await auth.isSpaceAdmin(spaceDid, callerDid))) {
			return jsonResponse(
				{ error: "Caller is not an admin of this space" },
				403,
			);
		}
	}
	return null;
}

async function route(
	req: Request,
	url: URL,
	repo: BridgeRepository,
	getAppId: () => string | undefined,
	auth: ApiAuth,
	callerDid: string,
): Promise<Response> {
	switch (url.pathname) {
		// Identity of the bridge itself, not space data: any authenticated
		// service caller may read it.
		case "/info": {
			const appId = getAppId();
			if (!appId)
				return jsonResponse({ error: "Discord bot still starting" }, 500);
			return jsonResponse({
				discordAppId: appId,
				bridgeDid: ATPROTO_BRIDGE_DID(),
			});
		}

		case "/get-guild-id": {
			const spaceId = url.searchParams.get("spaceId");
			if (!spaceId)
				return jsonResponse({ error: "spaceId query parameter required" }, 400);
			// Check standing before revealing whether the space is bridged, so
			// a non-admin caller cannot probe the bridge's space list.
			const denial = await requireAdmin(auth, callerDid, [spaceId]);
			if (denial) return denial;
			const configs = repo.listAllBridgeConfigs();
			const match = configs.find((c) => c.spaceDid === spaceId);
			if (match) return jsonResponse({ guildId: match.guildId });
			return jsonResponse({ error: "Guild not found for provided space" }, 404);
		}

		case "/get-space-id": {
			const guildId = url.searchParams.get("guildId");
			if (!guildId)
				return jsonResponse({ error: "guildId query parameter required" }, 400);
			const configs = repo.listBridgeConfigsForGuild(guildId);
			if (configs.length === 0)
				return jsonResponse(
					{ error: "Space not found for provided guild" },
					404,
				);
			const denial = await requireAdmin(
				auth,
				callerDid,
				configs.map((c) => c.spaceDid),
			);
			if (denial) return denial;
			return jsonResponse({ spaceIds: configs.map((c) => c.spaceDid) });
		}

		case "/bridges": {
			const guildId = url.searchParams.get("guildId");
			const bridges = guildId
				? repo.listBridgeConfigsForGuild(guildId)
				: repo.listAllBridgeConfigs();
			const denial = await requireAdmin(
				auth,
				callerDid,
				bridges.map((b) => b.spaceDid),
			);
			if (denial) return denial;
			return jsonResponse({ bridges });
		}

		case "/backfill/progress": {
			const spaceDid = url.searchParams.get("spaceDid");
			const guildId = url.searchParams.get("guildId");
			const channels = buildBackfillProgressPayload(repo, {
				spaceDid: spaceDid ?? undefined,
				guildId: guildId ?? undefined,
			});
			// A named space is checked even when it has no rows — otherwise an
			// empty reply would be readable without standing. Unscoped coverage
			// comes from the payload, so the check covers exactly the spaces
			// whose rows would be returned.
			const denial = await requireAdmin(
				auth,
				callerDid,
				spaceDid ? [spaceDid] : channels.map((c) => c.spaceDid),
			);
			if (denial) return denial;
			return jsonResponse({ channels });
		}

		// Sends the bridge owes a space after their retries were exhausted.
		// `pending` entries are still being re-offered; `terminal` ones are
		// counted drops. Event payloads are omitted — this is a status read, and
		// `id` is the handle `/sends/replay` takes.
		case "/sends/failed": {
			const spaceDid = url.searchParams.get("spaceDid") ?? undefined;
			const denial = await requireAdmin(
				auth,
				callerDid,
				spaceDid ? [spaceDid] : repo.listFailedSendSpaceDids(),
			);
			if (denial) return denial;
			return jsonResponse({
				...repo.countFailedSends(spaceDid),
				sends: repo.listFailedSends(50, spaceDid).map(sendStatus),
			});
		}

		// Recover a send the bridge stopped re-offering, including every entry
		// of an outage it could not outlast: the row is reset to due with a
		// fresh attempt budget, and the re-offer sweep delivers it — payload and
		// mapping replay included — on its next pass, within a minute. Resetting
		// only makes the entry due, so a replay is durable and cannot diverge
		// from the path a first delivery takes.
		case "/sends/replay": {
			if (req.method !== "POST") {
				return jsonResponse({ error: "POST required" }, 405);
			}
			const raw = url.searchParams.get("id");
			const id = raw === null ? Number.NaN : Number(raw);
			if (!Number.isInteger(id) || id <= 0) {
				return jsonResponse({ error: "id query parameter required" }, 400);
			}
			// The entry's space is checked before the row is reset, so a caller
			// without standing cannot cause a replay it will not be told about.
			const existing = repo.getFailedSend(id);
			if (!existing) {
				return jsonResponse({ error: "No queued send with that id" }, 404);
			}
			const denial = await requireAdmin(auth, callerDid, [existing.spaceDid]);
			if (denial) return denial;
			const replayed = repo.replayFailedSend(id);
			if (!replayed) {
				return jsonResponse({ error: "No queued send with that id" }, 404);
			}
			return jsonResponse({ replayed: sendStatus(replayed) });
		}

		default:
			return jsonResponse({ error: "Not found" }, 404);
	}
}

/**
 * Serialize per-(channel, space) backfill progress for the REST endpoint.
 *
 * Honest-by-construction: Discord's history is unbounded and there is no
 * message-count API, so a "remaining / percent" figure cannot be computed
 * without walking the full history — the payload deliberately omits any
 * denominator. Per-channel state comes from the durable `backfill_progress`
 * rows (survive restarts); `running` reflects the in-process registry only,
 * re-schedules it. A `blocked` row is terminal — no run will ever backfill
 * that pair — and its `blockedReason` says why.
 */
export function buildBackfillProgressPayload(
	repo: BridgeRepository,
	scope?: { spaceDid?: string; guildId?: string },
): Array<{
	spaceDid: string;
	channelId: string;
	guildId: string | null;
	kind: "channel" | "thread" | null;
	channelName: string | null;
	phase: "phase1" | "phase2" | "complete" | "blocked";
	messagesSynced: number;
	messagesSkipped: number;
	cursor: string | null;
	/** Thread rows only: Discord id of the parent channel (panel nesting). */
	parentId: string | null;
	/** Recent-window size at the phase1→phase2 transition. */
	windowSynced: number | null;
	/** `blocked` rows only: why no run will ever backfill this pair. */
	blockedReason: string | null;
	/** Roomy room id this channel/thread maps to, for sidebar-order joins. */
	roomyId: string | null;
	running: boolean;
	updatedAt: number;
}> {
	const rows = repo
		.listBackfillProgress(scope?.spaceDid)
		.filter((p) => !scope?.guildId || p.guildId === scope.guildId);
	return rows.map((p) => ({
		spaceDid: p.spaceDid,
		channelId: p.channelId,
		guildId: p.guildId,
		kind: p.kind,
		channelName: p.channelName,
		phase: p.phase,
		messagesSynced: p.messagesSynced,
		messagesSkipped: p.messagesSkipped,
		cursor: repo.getChannelCursor(p.spaceDid, p.channelId)?.lastMessageId ?? null,
		parentId: p.parentId,
		windowSynced: p.windowSynced,
		blockedReason: p.blockedReason,
		roomyId: repo.getRoomyRoomId(p.spaceDid, p.channelId) ?? null,
		running: isBackfillRunning(p.spaceDid, p.channelId),
		updatedAt: p.updatedAt,
	}));
}

/**
 * One failed-send entry as the HTTP surface reports it: the replay handle and
 * the drop's bookkeeping, never the event payload.
 */
function sendStatus(send: FailedSend): {
	id: number;
	spaceDid: string;
	op: string;
	discordId: string;
	attempts: number;
	lastError: string | null;
	firstFailedAt: number;
	lastFailedAt: number;
	nextRetryAt: number | null;
	terminal: boolean;
} {
	return {
		id: send.id,
		spaceDid: send.spaceDid,
		op: send.op,
		discordId: send.discordId,
		attempts: send.attempts,
		lastError: send.lastError,
		firstFailedAt: send.firstFailedAt,
		lastFailedAt: send.lastFailedAt,
		nextRetryAt: send.nextRetryAt,
		terminal: send.terminal,
	};
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		// `Authorization` is required: browser dashboards send the service-auth
		// JWT on every call, and preflight fails without it.
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
	};
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
