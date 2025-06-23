import { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { NodeSavedStateStore, NodeSavedSessionStore } from '@atproto/oauth-client-node';
import { SimpleStore, type Value } from '@atproto-labs/simple-store';
import { Agent } from '@atproto/api';
import express from 'express';
import open from 'open';
import { createServer } from 'http';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { OAuthConfig } from '../types/index.js';

// File-based implementation of SimpleStore
class FileStore<K extends string, V extends Value> implements SimpleStore<K, V> {
  constructor(private filePath: string) {}

  async get(key: K): Promise<V | undefined> {
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, V>;
      return data[key];
    } catch {
      return undefined;
    }
  }

  async set(key: K, value: V): Promise<void> {
    let data: Record<string, V> = {};
    try {
      data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, V>;
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }
    data[key] = value;
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  async del(key: K): Promise<void> {
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, V>;
      delete data[key];
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  async clear(): Promise<void> {
    try {
      unlinkSync(this.filePath);
    } catch {
      // File doesn't exist, already cleared
    }
  }
}

export class RoomyOAuthClient {
  private client: NodeOAuthClient;
  private config: OAuthConfig;
  private callbackServer?: ReturnType<typeof createServer>;

  constructor() {
    this.config = {
      client_id: 'https://roomy.space/oauth-client-cli.json',
      client_name: 'Roomy CLI',
      client_uri: 'https://roomy.space',
      redirect_uris: ['http://localhost:3000/callback'],
      scope: 'atproto transition:generic transition:chat.bsky',
      handleResolver: 'https://resolver.roomy.chat'
    };

    // Ensure OAuth storage directory exists
    const oauthDir = join(homedir(), '.roomy-cli', 'oauth');
    mkdirSync(oauthDir, { recursive: true });

    // Create store instances
    const stateStore: NodeSavedStateStore = new FileStore(join(oauthDir, 'state.json'));
    const sessionStore: NodeSavedSessionStore = new FileStore(join(oauthDir, 'session.json'));

    this.client = new NodeOAuthClient({
      clientMetadata: this.config,
      handleResolver: this.config.handleResolver,
      stateStore,
      sessionStore
    });
  }

  async authorize(handle: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const app = express();
      
      // Start callback server
      this.callbackServer = app.listen(3000, () => {
        console.log('🔐 Starting OAuth authorization...');
      });

      // Handle OAuth callback
      app.get('/callback', async (req, res) => {
        try {
          const searchParams = new URLSearchParams(req.url?.split('?')[1]);
          const result = await this.client.callback(searchParams);
          
          res.send(`
            <html>
              <body>
                <h1>✅ Authorization successful!</h1>
                <p>You can now close this window and return to the CLI.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);
          
          this.callbackServer?.close();
          resolve(result.session);
        } catch (error) {
          res.status(400).send(`
            <html>
              <body>
                <h1>❌ Authorization failed</h1>
                <p>Error: ${(error as Error).message}</p>
              </body>
            </html>
          `);
          this.callbackServer?.close();
          reject(error);
        }
      });

      // Start authorization flow
      this.client.authorize(handle, { scope: this.config.scope })
        .then(url => {
          console.log(`🌐 Opening browser for authorization: ${handle}`);
          open(url.toString());
        })
        .catch(reject);
    });
  }

  async restore(did: string) {
    return await this.client.restore(did);
  }
}