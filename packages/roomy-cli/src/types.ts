/**
 * ATProto session data persisted from AtpAgent.login()
 */
export interface SessionData {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
  email?: string;
  emailConfirmed: boolean;
}

/**
 * Mapping of Claude Code session IDs to Roomy room ULIDs
 * Stored in ROOMY_ROOM_MAP_FILE (default: ~/.roomy/rooms.json)
 */
export interface RoomMap {
  [sessionId: string]: string;
}

/**
 * Configuration loaded from environment variables
 */
export interface Config {
  /** Required: Which space to create rooms in */
  spaceDid: string;
  /** ATProto identifier (handle or DID) - from env or first-run prompt */
  identifier: string;
  /** ATProto app password - from env or first-run prompt */
  appPassword: string;
  /** Path to ATProto session cache file */
  sessionFile: string;
  /** Path to session ID → room ULID mapping file */
  roomMapFile: string;
  /** Leaf server URL */
  leafUrl: string;
  /** Leaf server DID for service auth */
  leafDid: string;
}
