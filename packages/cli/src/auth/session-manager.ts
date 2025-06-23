import keytar from 'keytar';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { SessionData } from '../types/index.js';

export class SessionManager {
  private configDir: string;
  private sessionFile: string;
  private serviceName = 'roomy-cli';

  constructor() {
    this.configDir = path.join(os.homedir(), '.roomy-cli');
    this.sessionFile = path.join(this.configDir, 'session.json');
  }

  async saveSession(sessionData: SessionData): Promise<void> {
    // Store sensitive tokens in keychain
    await keytar.setPassword(this.serviceName, 'accessToken', sessionData.accessToken);
    await keytar.setPassword(this.serviceName, 'refreshToken', sessionData.refreshToken);
    
    // Store passphrase if provided
    if (sessionData.passphrase) {
      await keytar.setPassword(this.serviceName, 'passphrase', sessionData.passphrase);
    }
    
    // Store non-sensitive data in config file
    const configData = {
      did: sessionData.did,
      handle: sessionData.handle,
      expiresAt: sessionData.expiresAt
    };
    
    await this.ensureConfigDir();
    await writeFile(this.sessionFile, JSON.stringify(configData, null, 2));
    
    console.log(`✅ Session saved for ${sessionData.handle}`);
  }

  async loadSession(): Promise<SessionData | null> {
    if (!existsSync(this.sessionFile)) {
      return null;
    }

    try {
      const configData = JSON.parse(await readFile(this.sessionFile, 'utf-8'));
      const accessToken = await keytar.getPassword(this.serviceName, 'accessToken');
      const refreshToken = await keytar.getPassword(this.serviceName, 'refreshToken');
      const passphrase = await keytar.getPassword(this.serviceName, 'passphrase');

      if (!accessToken || !refreshToken) {
        throw new Error('Tokens not found in keychain');
      }

      return {
        ...configData,
        accessToken,
        refreshToken,
        passphrase: passphrase || undefined
      };
    } catch (error) {
      console.warn('⚠️  Failed to load session, please log in again');
      return null;
    }
  }

  async clearSession(): Promise<void> {
    await keytar.deletePassword(this.serviceName, 'accessToken');
    await keytar.deletePassword(this.serviceName, 'refreshToken');
    await keytar.deletePassword(this.serviceName, 'passphrase');
    
    if (existsSync(this.sessionFile)) {
      await unlink(this.sessionFile);
    }
    
    console.log('🗑️  Session cleared');
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}