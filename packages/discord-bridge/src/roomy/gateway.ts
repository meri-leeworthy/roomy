/**
 * RoomyGateway: abstraction over sending events to Roomy spaces
 * and subscribing to events from Roomy spaces.
 *
 * Decouples service logic from the SpaceManager's concrete network I/O,
 * enabling tests to use an in-memory mock.
 */

import type { Event } from "@roomy-space/sdk";

export type RoomyEventCallback = (
	event: Event,
	meta: { spaceDid: string; isBackfill: boolean; userDid: string },
) => Promise<void>;

/**
 * The space's sidebar structure as the appserver reports it: categories in
 * render order, each with its children (room ids) in render order. `id` is
 * absent for categories written before `updateSidebar.v1` (the deprecated v0
 * had no stable category ids).
 */
export interface BridgeSidebarCategory {
	id?: string;
	name: string;
	children: string[];
}

export interface BridgeSidebar {
	categories: BridgeSidebarCategory[];
}

export interface RoomyGateway {
	/** Send a single event to a space. */
	sendEvent(spaceDid: string, event: Event): Promise<void>;

	/** Send multiple events atomically to a space. */
	sendEvents(spaceDid: string, events: Event[]): Promise<void>;

	/**
	 * Read the space's current sidebar structure (categories + ordered
	 * children). Used by the one-shot initial structure sync to merge Discord
	 * categories into the sidebar instead of overwriting it.
	 */
	getSidebar(spaceDid: string): Promise<BridgeSidebar>;

	/** Subscribe to events from a space. Callback receives decoded events. */
	subscribe(spaceDid: string, callback: RoomyEventCallback): Promise<void>;

	/** Unsubscribe from a space. */
	unsubscribe(spaceDid: string): Promise<void>;

	/** Disconnect from all connected spaces. */
	disconnectAll(): Promise<void>;
}
