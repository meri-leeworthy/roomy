/**
 * Auth wiring for the bridge's status API.
 *
 * Callers present a service-auth JWT (`com.atproto.server.getServiceAuth`)
 * addressed to the bridge's DID. That proves which account is asking; the
 * routes that return space data additionally require the caller to hold an
 * admin edge in the space (or in every space the response covers).
 *
 * Admin standing comes from the appserver's member list through the bridge's
 * own service-auth client, so the calling account never needs to be able to
 * read the space itself. The space manager is created after the API starts —
 * ATProto login happens in parallel with the listener — so the getter stays
 * nil for that window and admin checks answer false.
 */

import { createServiceAuthVerifier } from "@roomy/service-auth";
import type { ApiAuth } from "./api.ts";
import { ATPROTO_BRIDGE_DID } from "./env.ts";
import type { SpaceManager } from "./roomy/space-manager.ts";

export function createBridgeApiAuth(
	getSpaceManager: () => SpaceManager | undefined,
): ApiAuth {
	return {
		verifyRequest: createServiceAuthVerifier({
			audience: ATPROTO_BRIDGE_DID(),
		}),
		isSpaceAdmin: async (spaceDid, did) => {
			const spaceManager = getSpaceManager();
			return spaceManager ? spaceManager.isAdmin(spaceDid, did) : false;
		},
	};
}
