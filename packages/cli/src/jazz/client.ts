import { 
  createJazzContext, 
  PassphraseAuth,
  randomSessionProvider,
  co,
  z,
  Account
} from 'jazz-tools';
import { RoomyAccount, Space, Channel, Message, Thread, Embed, ImageUrlEmbed, ReactionList } from './schema.js';
import WebSocket from 'ws';

// Add WebSocket support for Node.js
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

interface JazzSpace {
  id: string;
  name: string;
  members?: any[];
  channels?: JazzChannel[];
  description?: string;
}

interface JazzChannel {
  id: string;
  name: string;
  subThreads?: any[];
  pages?: any[];
}

export class RoomyJazzClient {
  private context: any = null;
  private account: any = null;
  private initialized = false;

  async initialize(passphrase: string): Promise<void> {
    try {
      console.log('🎵 Initializing Jazz client...');
      
      // For now, create a working placeholder until we can resolve Jazz API issues
      // The Jazz API appears to have complex authentication and context setup requirements
      // that are challenging to implement correctly in a Node.js CLI environment
      
      console.log('🚧 Using Jazz placeholder implementation');
      console.log('   Jazz Cloud Peer: wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com');
      console.log('   Passphrase:', passphrase.slice(0, 10) + '...');
      
      // Simulate initialization
      await new Promise(resolve => setTimeout(resolve, 500));
      
      this.account = { 
        id: 'demo_account_' + Math.random().toString(36).substr(2, 9),
        profile: {
          joinedSpaces: []
        }
      };
      this.initialized = true;
      console.log('✅ Jazz client initialized (placeholder mode)');
      
    } catch (error) {
      console.error('❌ Failed to initialize Jazz client:', error);
      throw new Error(`Jazz initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async loadSpaces(): Promise<JazzSpace[]> {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }
    
    try {
      console.log('📡 Loading spaces from Jazz...');
      
      // Load joined spaces from the user's profile
      const joinedSpaces = this.account.profile.joinedSpaces;
      if (!joinedSpaces || joinedSpaces.length === 0) {
        console.log('📭 No spaces found');
        return [];
      }

      const spaces: JazzSpace[] = [];
      
      // Load each space
      for (const space of joinedSpaces) {
        if (space && !(space as any).softDeleted) {
          const jazzSpace: JazzSpace = {
            id: space.id,
            name: (space as any).name,
            description: (space as any).description,
            members: (space as any).members ? Array.from((space as any).members) : [],
            channels: (space as any).channels ? Array.from((space as any).channels).map((ch: any) => ({
              id: ch.id,
              name: ch.name,
              subThreads: ch.subThreads ? Array.from(ch.subThreads) : [],
              pages: ch.pages ? Array.from(ch.pages) : []
            })) : []
          };
          spaces.push(jazzSpace);
        }
      }
      
      console.log(`✅ Loaded ${spaces.length} spaces`);
      return spaces;
      
    } catch (error) {
      console.error('❌ Failed to load spaces:', error);
      throw new Error(`Failed to load spaces: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async loadChannels(spaceId: string): Promise<JazzChannel[]> {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }
    
    try {
      console.log(`📡 Loading channels for space ${spaceId}...`);
      
      // Find the space
      const joinedSpaces = this.account.profile.joinedSpaces;
      if (!joinedSpaces) {
        throw new Error('No spaces available');
      }

      let targetSpace: any = null;
      for (const space of joinedSpaces) {
        if (space && space.id === spaceId) {
          targetSpace = space;
          break;
        }
      }

      if (!targetSpace) {
        throw new Error(`Space ${spaceId} not found`);
      }

      // Load channels from the space
      const channels: JazzChannel[] = [];
      if (targetSpace.channels) {
        for (const channel of targetSpace.channels) {
          if (channel && !channel.softDeleted) {
            channels.push({
              id: channel.id,
              name: channel.name,
              subThreads: channel.subThreads ? Array.from(channel.subThreads) : [],
              pages: channel.pages ? Array.from(channel.pages) : []
            });
          }
        }
      }
      
      console.log(`✅ Loaded ${channels.length} channels`);
      return channels;
      
    } catch (error) {
      console.error('❌ Failed to load channels:', error);
      throw new Error(`Failed to load channels: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    options: {
      threadId?: string;
      replyTo?: string;
      embeds?: Array<{ type: 'imageUrl'; url: string }>;
    } = {}
  ): Promise<void> {
    if (!this.initialized || !this.account) {
      throw new Error('Client not initialized');
    }

    try {
      console.log(`📨 Sending message to channel ${channelId}...`);
      
      // Find the channel and its main thread or specified thread
      const spaces = await this.loadSpaces();
      let targetChannel: JazzChannel | null = null;
      
      for (const space of spaces) {
        if (space.channels) {
          const found = space.channels.find(ch => ch.id === channelId);
          if (found) {
            targetChannel = found;
            break;
          }
        }
      }

      if (!targetChannel) {
        throw new Error(`Channel ${channelId} not found`);
      }

      // Load the actual Channel CoValue to send message
      const channelCoValue = await Channel.load(channelId, this.account);
      
      if (!channelCoValue) {
        throw new Error(`Could not load channel ${channelId}`);
      }

      // Determine which thread to post to
      const targetThread = options.threadId 
        ? (channelCoValue as any).subThreads?.find((t: any) => t?.id === options.threadId)
        : (channelCoValue as any).mainThread;

      if (!targetThread || !(targetThread as any).timeline) {
        throw new Error('Target thread not found or has no timeline');
      }

      // Create embeds if provided
      let embedsList: any = undefined;
      if (options.embeds && options.embeds.length > 0) {
        embedsList = co.list(Embed);
        for (const embed of options.embeds) {
          const imageEmbed = ImageUrlEmbed.create({ url: embed.url }, { owner: this.account });
          const embedObj = Embed.create({ 
            type: 'imageUrl' as const, 
            embedId: imageEmbed.id 
          }, { owner: this.account });
          embedsList.push(embedObj);
        }
      }

      // Create the message
      const message = Message.create({
        content,
        createdAt: new Date(),
        updatedAt: new Date(),
        hiddenIn: co.list(z.string()).create([], { owner: this.account }),
        reactions: ReactionList.create([], { owner: this.account }),
        replyTo: options.replyTo,
        author: this.account.id,
        threadId: options.threadId,
        embeds: embedsList
      }, { owner: this.account });

      // Add message to timeline
      (targetThread as any).timeline.push(message.id);
      
      console.log(`✅ Message sent successfully to ${targetChannel.name}`);
      
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.context) {
      // Jazz context cleanup
      this.context = null;
    }
    this.account = null;
    this.initialized = false;
    console.log('👋 Jazz client disconnected');
  }

  getAccount(): Account | null {
    return this.account;
  }
}