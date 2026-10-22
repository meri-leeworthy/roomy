import { transport } from "@roomy-space/sdk";
import type { RoomyClient } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";

const log = createLogger("spaces");

export class SpaceManager {
	#xrpc: transport.DirectXrpcClient;
	#spaces = new Map<string, { streamDid: string }>();

	constructor(client: RoomyClient, appserverUrl: string, appserverDid: string) {
		const serviceAuth = new transport.ServiceAuthClient(client.agent);
		this.#xrpc = new transport.DirectXrpcClient(appserverUrl, appserverDid, serviceAuth);
	}

	/** Expose the XRPC client for use by LiveRoomyGateway. */
	get xrpc(): transport.DirectXrpcClient {
		return this.#xrpc;
	}

	async getOrConnect(spaceDid: string): Promise<{ streamDid: string }> {
		const existing = this.#spaces.get(spaceDid);
		if (existing) return existing;

		log.info(`Connecting to space ${spaceDid}...`);
		// Verify space exists via XRPC
		await this.#xrpc.query("space.roomy.space.getMetadata", { spaceId: spaceDid });

		const entry = { streamDid: spaceDid };
		this.#spaces.set(spaceDid, entry);
		log.info(`Connected to space ${spaceDid}`);
		return entry;
	}

	/**
	 * Whether `did` holds an admin edge in `spaceDid`.
	 *
	 * Reads the appserver's member list through the bridge's own service-auth
	 * client, so the caller being checked need not be able to read the space
	 * itself. `search` narrows the response to the DID in question.
	 *
	 * Fails closed: an unreachable appserver, or a space the bridge cannot
	 * read, reports "not an admin" and logs why.
	 */
	async isAdmin(spaceDid: string, did: string): Promise<boolean> {
		try {
			const { members } = await this.#xrpc.query(
				"space.roomy.space.getMembers",
				{ spaceId: spaceDid, search: did },
			);
			return members.some((member) => member.did === did && member.isAdmin);
		} catch (err) {
			log.warn("admin check failed", err);
			return false;
		}
	}

	get(spaceDid: string): { streamDid: string } | undefined {
		return this.#spaces.get(spaceDid);
	}

	async disconnectAll(): Promise<void> {
		this.#spaces.clear();
	}
}
