/**
 * System messages: bridge-authored notices posted to a Roomy channel for
 * Roomy admins (capacity alerts).
 *
 * Destination is configured with SYSTEM_SPACE (space DID) + SYSTEM_CHANNEL
 * (room ULID). When either is unset, sending is a no-op — the bridge runs
 * fine without admin notifications. The bridge's ATProto account must be a
 * member of the space with write access to the channel.
 *
 * Best-effort: failures are logged, never thrown — a notification must not
 * break capacity enforcement.
 */

import { newUlid, toBytes, Ulid } from "@roomy-space/sdk";
import { SYSTEM_CHANNEL, SYSTEM_SPACE } from "../env.ts";
import { createLogger } from "../logger.ts";
import type { RoomyGateway } from "./gateway.ts";

const log = createLogger("system-messages");

/** True when SYSTEM_SPACE and SYSTEM_CHANNEL are both configured. */
export function systemMessagesConfigured(): boolean {
	return SYSTEM_SPACE().length > 0 && SYSTEM_CHANNEL().length > 0;
}

/**
 * Send a system message as the bridge account into the configured system
 * channel. No-op (returns false) without SYSTEM_SPACE/SYSTEM_CHANNEL.
 * Never throws.
 */
export async function sendSystemMessage(
	roomy: RoomyGateway,
	text: string,
): Promise<boolean> {
	const spaceDid = SYSTEM_SPACE();
	const channelId = SYSTEM_CHANNEL();
	if (!spaceDid || !channelId) {
		return false;
	}

	try {
		const event = {
			id: newUlid(),
			room: Ulid.assert(channelId),
			$type: "space.roomy.message.createMessage.v0" as const,
			body: {
				mimeType: "text/markdown",
				data: toBytes(new TextEncoder().encode(text)),
			},
			extensions: {},
		};
		await roomy.sendEvent(spaceDid, event);
		log.info("system message sent", { spaceDid, channelId });
		return true;
	} catch (err) {
		log.error(
			`failed to send system message to ${spaceDid}/${channelId}`,
			err,
		);
		return false;
	}
}
