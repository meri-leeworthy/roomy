import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { 
  NodeSavedSession, 
  NodeSavedSessionStore, 
  NodeSavedState, 
  NodeSavedStateStore 
} from '@atproto/oauth-client-node';

/**
 * File-based implementation of NodeSavedSessionStore
 * Stores OAuth session data (access tokens, refresh tokens, etc.)
 */
export class FileSessionStore implements NodeSavedSessionStore {
  private filePath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
    this.filePath = join(this.configDir, 'oauth-sessions.json');
  }

  async set(sub: string, sessionData: NodeSavedSession): Promise<void> {
    await this.ensureConfigDir();
    
    let sessions: Record<string, NodeSavedSession> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        sessions = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }
    
    sessions[sub] = sessionData;
    await writeFile(this.filePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  }

  async get(sub: string): Promise<NodeSavedSession | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }
      
      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, NodeSavedSession> = JSON.parse(data);
      return sessions[sub];
    } catch {
      return undefined;
    }
  }

  async del(sub: string): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      
      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, NodeSavedSession> = JSON.parse(data);
      delete sessions[sub];
      
      if (Object.keys(sessions).length === 0) {
        await unlink(this.filePath);
      } else {
        await writeFile(this.filePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
      }
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

/**
 * File-based implementation of NodeSavedStateStore
 * Stores OAuth state data for CSRF prevention
 */
export class FileStateStore implements NodeSavedStateStore {
  private filePath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
    this.filePath = join(this.configDir, 'oauth-states.json');
  }

  async set(key: string, internalState: NodeSavedState): Promise<void> {
    await this.ensureConfigDir();
    
    let states: Record<string, NodeSavedState & { timestamp: number }> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        states = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }
    
    // Clean up expired states (older than 1 hour)
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    for (const [stateKey, stateData] of Object.entries(states)) {
      if (now - stateData.timestamp > oneHour) {
        delete states[stateKey];
      }
    }
    
    states[key] = { ...internalState, timestamp: now };
    await writeFile(this.filePath, JSON.stringify(states, null, 2), { mode: 0o600 });
  }

  async get(key: string): Promise<NodeSavedState | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }
      
      const data = await readFile(this.filePath, 'utf-8');
      const states: Record<string, NodeSavedState & { timestamp: number }> = JSON.parse(data);
      const stateData = states[key];
      
      if (!stateData) {
        return undefined;
      }
      
      // Check if state has expired (older than 1 hour)
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (now - stateData.timestamp > oneHour) {
        await this.del(key);
        return undefined;
      }
      
      // Remove timestamp before returning
      const { timestamp, ...state } = stateData;
      return state;
    } catch {
      return undefined;
    }
  }

  async del(key: string): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      
      const data = await readFile(this.filePath, 'utf-8');
      const states: Record<string, NodeSavedState & { timestamp: number }> = JSON.parse(data);
      delete states[key];
      
      if (Object.keys(states).length === 0) {
        await unlink(this.filePath);
      } else {
        await writeFile(this.filePath, JSON.stringify(states, null, 2), { mode: 0o600 });
      }
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

/**
 * Simple file-based runtime lock implementation
 * For single-instance CLI usage, this provides basic locking
 */
export class FileRuntimeLock {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockFile = join(this.configDir, `lock-${key}.json`);
    const lockData = {
      timestamp: Date.now(),
      pid: process.pid
    };

    // Check for existing lock
    if (existsSync(lockFile)) {
      try {
        const existingLock = JSON.parse(await readFile(lockFile, 'utf-8'));
        const lockAge = Date.now() - existingLock.timestamp;
        
        // If lock is older than 45 seconds, consider it stale
        if (lockAge < 45000) {
          throw new Error(`Lock already exists for key: ${key}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('Lock already exists')) {
          throw error;
        }
        // JSON parse error, proceed to create new lock
      }
    }

    // Create lock
    await this.ensureConfigDir();
    await writeFile(lockFile, JSON.stringify(lockData, null, 2));

    try {
      return await fn();
    } finally {
      // Release lock
      try {
        await unlink(lockFile);
      } catch {
        // Lock file might have been cleaned up already
      }
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}