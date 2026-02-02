import type { Config } from "./types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Default Roomy directory in user's home
 */
const ROOMY_DIR = path.join(os.homedir(), ".roomy");

/**
 * Load configuration from environment variables
 * @throws Error if required variables are missing
 */
export function loadConfig(): Config {
  const spaceDid = process.env.ROOMY_SPACE_DID;
  if (!spaceDid) {
    throw new Error(
      "ROOMY_SPACE_DID environment variable is required. Set it to the DID of the space you want to create rooms in."
    );
  }

  const identifier = process.env.ATPROTO_IDENTIFIER || "";
  const appPassword = process.env.ATPROTO_APP_PASSWORD || "";

  // Credentials are required on first run, but we'll check them later
  // to allow for better error messages
  const roomyDir = process.env.ROOMY_DIR || ROOMY_DIR;

  return {
    spaceDid,
    identifier,
    appPassword,
    sessionFile: process.env.ROOMY_SESSION_FILE || path.join(roomyDir, "session.json"),
    roomMapFile: process.env.ROOMY_ROOM_MAP_FILE || path.join(roomyDir, "rooms.json"),
    leafUrl: process.env.LEAF_URL || "http://localhost:3000",
    leafDid: process.env.LEAF_DID || "did:web:localhost",
  };
}

/**
 * Ensure the Roomy directory exists
 */
export async function ensureRoomyDir(): Promise<void> {
  const roomyDir = process.env.ROOMY_DIR || ROOMY_DIR;
  await fs.mkdir(roomyDir, { recursive: true });
}

/**
 * Read and parse a JSON file
 * @throws Error if file doesn't exist or contains invalid JSON
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file atomically
 * Uses temp file pattern to avoid corruption
 */
export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempPath, filePath);
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
