import { AtpAgent, CredentialSession } from "@atproto/api";
import type { Config, SessionData } from "./types.js";
import { ensureRoomyDir, readJson, writeJson, fileExists } from "./config.js";

/**
 * Load or initialize ATProto authentication
 *
 * On first run:
 * - Creates AtpAgent with CredentialSession
 * - Logs in with identifier and password
 * - Saves session data to file
 * - Returns agent
 *
 * On subsequent runs:
 * - Loads session data from file
 * - Resumes session with CredentialSession
 * - Handles token refresh automatically
 * - Returns agent
 *
 * @throws Error if authentication fails (exit code 1)
 */
export async function getOrInitAuth(config: Config): Promise<AtpAgent> {
  await ensureRoomyDir();

  // Check if session file exists
  const hasSession = await fileExists(config.sessionFile);

  if (hasSession) {
    return await resumeSession(config);
  } else {
    return await createSession(config);
  }
}

/**
 * Create a new session by logging in
 */
async function createSession(config: Config): Promise<AtpAgent> {
  if (!config.identifier || !config.appPassword) {
    throw new Error(
      "Authentication required. Set ATPROTO_IDENTIFIER and ATPROTO_APP_PASSWORD environment variables."
    );
  }

  const session = new CredentialSession(new URL(config.leafUrl));
  const agent = new AtpAgent(session);

  try {
    const result = await agent.login({
      identifier: config.identifier,
      password: config.appPassword,
    });

    const sessionData: SessionData = {
      accessJwt: result.data.accessJwt,
      refreshJwt: result.data.refreshJwt,
      handle: result.data.handle,
      did: result.data.did,
      email: result.data.email,
      emailConfirmed: result.data.emailConfirmed,
    };

    await writeJson(config.sessionFile, sessionData);
    return agent;
  } catch (error) {
    throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resume an existing session from file
 */
async function resumeSession(config: Config): Promise<AtpAgent> {
  try {
    const sessionData = await readJson<SessionData>(config.sessionFile);

    const session = new CredentialSession(new URL(config.leafUrl));
    await session.resumeSession(sessionData);

    const agent = new AtpAgent(session);

    // Save refreshed tokens
    const refreshedData: SessionData = {
      accessJwt: session.data.accessJwt,
      refreshJwt: session.data.refreshJwt,
      handle: session.data.handle,
      did: session.data.did,
      email: session.data.email,
      emailConfirmed: session.data.emailConfirmed ?? false,
    };

    await writeJson(config.sessionFile, refreshedData);

    return agent;
  } catch (error) {
    // If session is corrupted or expired, delete it and re-auth
    console.error("Session corrupted or expired. Re-authenticating...");

    try {
      await import("node:fs/promises").then((fs) => fs.unlink(config.sessionFile));
    } catch {
      // Ignore errors deleting the file
    }

    return await createSession(config);
  }
}
