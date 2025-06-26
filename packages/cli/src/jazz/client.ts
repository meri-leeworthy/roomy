import { 
  co,
  z,
  Account,
  Group,
} from 'jazz-tools';
import { RoomyAccount, Space, Channel, Message, Thread, Embed, ImageUrlEmbed, ReactionList, SpaceList, ChannelList, type SpaceList as SpaceListType, Reaction } from './schema.js';
import WebSocket from 'ws';
import { startWorker } from 'jazz-tools/worker';

// Add WebSocket support for Node.js
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as any;
}

export class RoomyJazzClient {
  private context: any = null;
  private account: Account | null = null;
  private initialized = false;

  async initialize(accountID: string, accountSecret: string, register?: boolean): Promise<void> {
    try {
      console.log('🎵 Initializing Jazz client...');
      
      // For now, create a working placeholder until we can resolve Jazz API issues
      // The Jazz API appears to have complex authentication and context setup requirements
      // that are challenging to implement correctly in a Node.js CLI environment
      console.log('   Jazz Cloud Peer: wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com');
      console.log('   Account ID:', accountID);
      console.log('   Account Secret:', accountSecret.slice(0, 10) + '...');

      type WorkerOptions = Parameters<typeof startWorker>[0];
      const workerOptions: WorkerOptions = {
        accountID,
        accountSecret: accountSecret,
        syncServer: 'wss://cloud.jazz.tools/?key=flo.bit.dev@gmail.com',
        WebSocket,
        AccountSchema: RoomyAccount
      }

      const worker = await startWorker(workerOptions);
      this.account = worker.worker;

      await worker.waitForConnection();

      // await this.account?.ensureLoaded({resolve: {profile: true}});
      // console.log("profile", this.account.profile)
      // await this.account.waitForAllCoValuesSync();
      this.initialized = true;
      console.log('✅ Jazz client initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize Jazz client:', error);
      throw new Error(`Jazz initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async loadSpaces() {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }
    
    try {
      const account = this.getAccount();
      await account?.ensureLoaded({resolve: {profile: {joinedSpaces: { $each: {members: true, channels: true}}, roomyInbox: true}}});
      const spaces = account?.profile?.joinedSpaces;
      return spaces
    } catch (error) {
      console.error('❌ Failed to load spaces:', error);
      throw new Error(`Failed to load spaces: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async loadChannels(spaceId: string) {
    if (!this.initialized || !this.account?.profile) {
      throw new Error('Client not initialized');
    }
    
    try {
      console.log(`📡 Loading channels for space ${spaceId}...`);
      
      const account = this.getAccount();
      await account?.ensureLoaded({resolve: {profile: {joinedSpaces: { $each: {members: true, channels: {$each: true}}}, roomyInbox: true}}});

      // Find the space
      const targetSpace = await Space.load(spaceId, {resolve: {channels: {$each: true}}})

      if (!targetSpace) {
        throw new Error(`Space ${spaceId} not found`);
      }

      // Load channels from the space
      const channels = targetSpace.channels
      
      console.log(`✅ Loaded ${channels.length} channels`);
      return channels;
      
    } catch (error) {
      console.error('❌ Failed to load channels:', error);
      throw new Error(`Failed to load channels: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async sendMessage(
    spaceId: string,
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
      
      const space = await Space.load(spaceId, {resolve: {channels: {$each: true}}});

      if (!space) {
        throw new Error(`Space ${spaceId} not found`);
      }

      console.log("space", space)

      const adminGroup = await Group.load(space.adminGroupId);

      // Find the channel and its main thread or specified thread
      let targetChannel = await Channel.load(channelId, {resolve: {}});

      if (!targetChannel) {
        throw new Error(`Channel ${channelId} not found`);
      }

      // Load the actual Channel CoValue to send message
      const channelCoValue = await Channel.load(channelId, {loadAs: this.account, resolve: {mainThread: {timeline: true}, subThreads: {$each: true}}});
      
      if (!channelCoValue) {
        throw new Error(`Could not load channel ${channelId}`);
      }

      console.log("channel", channelCoValue)

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

      console.log("targetThread", targetThread)

      // Create the message
      const message = createMessage(content, options.replyTo, adminGroup || undefined);

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

  getAccount() {
    return this.account?.castAs(RoomyAccount) ?? null;
  }
}

export function publicGroup(readWrite: "reader" | "writer" = "reader") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}

export function createMessage(
  input: string,
  replyTo?: string,
  admin?: co.loaded<typeof Group>,
) {
  const readingGroup = publicGroup("reader");

  if (admin) {
    readingGroup.extend(admin);
  }

  const publicWriteGroup = publicGroup("writer");

  const message = Message.create(
    {
      content: input,
      createdAt: new Date(),
      updatedAt: new Date(),
      reactions: co.list(Reaction).create([], publicWriteGroup),
      replyTo: replyTo,
      hiddenIn: co.list(z.string()).create([], readingGroup),
    },
    readingGroup,
  );

  return message;
}