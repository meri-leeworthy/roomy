import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { NodeSavedSession } from '@atproto/oauth-client-node';
import { RoomyOAuthClient } from './oauth-client.js';

interface CliSessionData {
  did: string;
  handle: string;
  passphrase?: string;
}

/**
 * Enhanced session manager that works with NodeOAuthClient
 * Manages both OAuth sessions and Jazz passphrases
 */
export class OAuthSessionManager {
  private configDir: string;
  private sessionFile: string;
  private oauthClient: RoomyOAuthClient;

  constructor() {
    this.configDir = path.join(os.homedir(), '.roomy-cli');
    this.sessionFile = path.join(this.configDir, 'cli-session.json');
    this.oauthClient = new RoomyOAuthClient();
  }

  async login(handle: string): Promise<CliSessionData> {
    console.log(`🔐 Starting OAuth login for ${handle}...`);
    
    // Start OAuth flow
    const oauthSession = await this.oauthClient.authorize(handle);
    console.log('✅ OAuth authorization complete');
    
    // Get Jazz passphrase from keyserver
    console.log('🎵 Getting Jazz credentials...');
    const passphrase = await this.getJazzPassphrase(oauthSession.sub);
    
    const sessionData: CliSessionData = {
      did: oauthSession.sub,
      handle,
      passphrase
      // Note: OAuth session is managed by the OAuth client's session store
    };
    
    // Save session
    await this.saveSession(sessionData);
    console.log(`✅ Login complete for ${handle}`);
    
    return sessionData;
  }

  async loadSession(): Promise<CliSessionData | null> {
    if (!existsSync(this.sessionFile)) {
      return null;
    }

    try {
      const sessionData: CliSessionData = JSON.parse(await readFile(this.sessionFile, 'utf-8'));
      
      // OAuth session restoration is handled by the OAuth client internally
      // The session store manages tokens automatically
      
      return sessionData;
    } catch (error) {
      console.warn('⚠️  Failed to load session, please log in again');
      return null;
    }
  }

  async saveSession(sessionData: CliSessionData): Promise<void> {
    await this.ensureConfigDir();
    
    // Save non-sensitive session data to file
    // OAuth tokens are already handled by the OAuth client's session store
    const configData = {
      did: sessionData.did,
      handle: sessionData.handle,
      passphrase: sessionData.passphrase
    };
    
    await writeFile(this.sessionFile, JSON.stringify(configData, null, 2));
  }

  async clearSession(): Promise<void> {
    try {
      // Load current session to get DID for OAuth cleanup
      const session = await this.loadSession();
      if (session?.did) {
        // This will clean up the OAuth session store
        await this.oauthClient.restore(session.did);
      }
    } catch {
      // Ignore errors during OAuth cleanup
    }
    
    // Remove CLI session file
    if (existsSync(this.sessionFile)) {
      await unlink(this.sessionFile);
    }
    
    console.log('🗑️  Session cleared');
  }

  /**
   * Get Jazz passphrase from the Roomy keyserver
   */
  private async getJazzPassphrase(did: string): Promise<string> {
    try {
      // TODO: Implement actual keyserver call
      // For now, return a placeholder passphrase
      console.log('🚧 Jazz keyserver integration not yet implemented');
      return `demo-passphrase-${did.slice(-8)}`;
    } catch (error) {
      console.error('Failed to get Jazz passphrase:', error);
      throw new Error('Could not retrieve Jazz credentials');
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }

  /**
   * Get a fresh OAuth agent for making authenticated requests
   */
  async getAgent(): Promise<any> {
    const session = await this.loadSession();
    if (!session?.did) {
      throw new Error('No valid session found');
    }

    // The OAuth client will handle token refresh automatically
    return this.oauthClient.restore(session.did);
  }
}