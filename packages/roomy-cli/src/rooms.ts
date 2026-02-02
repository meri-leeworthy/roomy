import type { Agent } from "@atproto/api";
import type { RoomMap } from "./types.js";
import { readJson, writeJson } from "./config.js";
import { ulid } from "ulidx";

/**
 * Load the room map from disk
 * Creates an empty map if file doesn't exist
 */
export async function loadRoomMap(roomMapFile: string): Promise<RoomMap> {
  try {
    return await readJson<RoomMap>(roomMapFile);
  } catch {
    return {};
  }
}

/**
 * Get or create a room for a given Claude Code session
 *
 * 1. Check if session ID exists in roomMap
 * 2. If exists, return the room ULID
 * 3. If missing:
 *    - Create a new room named "claude-session-{id}"
 *    - Store the mapping in roomMap
 *    - Write roomMap to disk
 *    - Return the new room ULID
 *
 * @returns The room ULID for the session
 * @throws Error if room creation fails (exit code 2)
 */
export async function getOrCreateRoomForSession(
  agent: Agent,
  spaceDid: string,
  sessionId: string,
  roomMap: RoomMap,
  roomMapFile: string
): Promise<string> {
  // Check if room already exists for this session
  const existingRoom = roomMap[sessionId];
  if (existingRoom) {
    return existingRoom;
  }

  // Create new room
  const roomName = `claude-session-${sessionId}`;

  try {
    const response = await agent.api.com.atproto.repo.createRecord(
      {
        repo: agent.assertDid,
        collection: "town.muni.room.createRoom",
        rkey: getRandomUlid(),
      },
      {
        room: spaceDid,
        name: roomName,
        description: `Claude Code session: ${sessionId}`,
      }
    );

    const roomUlid = response.data.uri.split("/").pop()!;

    // Update room map
    roomMap[sessionId] = roomUlid;
    await writeJson(roomMapFile, roomMap);

    return roomUlid;
  } catch (error) {
    throw new Error(
      `Failed to create room: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generate a random ULID for room creation
 */
function getRandomUlid(): string {
  return ulid();
}
