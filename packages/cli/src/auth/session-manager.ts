import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { SessionData } from '../types/index.js';

// Simple file-based credential storage (for development)
// In production, this should use proper keychain/credential manager
class SimpleCredentialStore {
  private credsFile: string;

  constructor(configDir: string) {
    this.credsFile = path.join(configDir, '.credentials');
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    let creds: Record<string, Record<string, string>> = {};
    try {
      if (existsSync(this.credsFile)) {
        creds = JSON.parse(await readFile(this.credsFile, 'utf-8'));
      }
    } catch {
      // File doesn't exist or is invalid
    }
    
    if (!creds[service]) {
      creds[service] = {};
    }
    creds[service][account] = password;
    
    await writeFile(this.credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    try {
      if (!existsSync(this.credsFile)) {
        return null;
      }
      const creds = JSON.parse(await readFile(this.credsFile, 'utf-8'));
      return creds[service]?.[account] || null;
    } catch {
      return null;
    }
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    try {
      if (!existsSync(this.credsFile)) {
        return false;
      }
      const creds = JSON.parse(await readFile(this.credsFile, 'utf-8'));
      if (creds[service]?.[account]) {
        delete creds[service][account];
        if (Object.keys(creds[service]).length === 0) {
          delete creds[service];
        }
        await writeFile(this.credsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export class SessionManager {
  private configDir: string;
  private sessionFile: string;
  private serviceName = 'roomy-cli';
  private credStore: SimpleCredentialStore;

  constructor() {
    this.configDir = path.join(os.homedir(), '.roomy-cli');
    this.sessionFile = path.join(this.configDir, 'session.json');
    this.credStore = new SimpleCredentialStore(this.configDir);
  }

  async saveSession(sessionData: SessionData): Promise<void> {
    // Store sensitive tokens in credential store
    await this.credStore.setPassword(this.serviceName, 'accessToken', sessionData.accessToken);
    await this.credStore.setPassword(this.serviceName, 'refreshToken', sessionData.refreshToken);
    
    // Store passphrase if provided
    if (sessionData.passphrase) {
      await this.credStore.setPassword(this.serviceName, 'passphrase', sessionData.passphrase);
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
      const accessToken = await this.credStore.getPassword(this.serviceName, 'accessToken');
      const refreshToken = await this.credStore.getPassword(this.serviceName, 'refreshToken');
      const passphrase = await this.credStore.getPassword(this.serviceName, 'passphrase');

      if (!accessToken || !refreshToken) {
        throw new Error('Tokens not found in credential store');
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
    await this.credStore.deletePassword(this.serviceName, 'accessToken');
    await this.credStore.deletePassword(this.serviceName, 'refreshToken');
    await this.credStore.deletePassword(this.serviceName, 'passphrase');
    
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