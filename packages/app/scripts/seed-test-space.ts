#!/usr/bin/env tsx
/**
 * Seed a test Roomy space with ~100,000 events.
 *
 * Uses the Leaf CLI's send-events command to inject events directly into Leaf.
 * The Leaf server must be started with --unsafe-auth-token matching LEAF_TEST_TOKEN.
 *
 * Usage:
 *   LEAF_URL=http://localhost:5530 \
 *   LEAF_TEST_TOKEN=dev-token \
 *   SPACE_STREAM_DID=did:example:stream123 \
 *   pnpm seed:test-space
 *
 * Environment variables:
 *   LEAF_URL - Leaf server URL (default: http://localhost:5530)
 *   LEAF_TEST_TOKEN - Token that matches Leaf's --unsafe-auth-token (default: test123)
 *   SPACE_STREAM_DID - Stream DID of the space to seed (required)
 *   EVENT_COUNT - Number of events to create (default: 100,000)
 *   ROOM_COUNT - Number of rooms to create (default: 100)
 *   USER_COUNT - Number of fake users to simulate (default: 50)
 */

import { io } from "socket.io-client";
import parser from "socket.io-msgpack-parser";
import { encode, decode, BytesWrapper } from "@atcute/cbor";
import { newUlid, toBytes } from "@roomy/sdk";

// Configuration from environment
const LEAF_URL = process.env.LEAF_URL || "http://localhost:5530";
const LEAF_TEST_TOKEN = process.env.LEAF_TEST_TOKEN || "test123";
const SPACE_STREAM_DID = process.env.SPACE_STREAM_DID;
const EVENT_COUNT = parseInt(process.env.EVENT_COUNT || "100000");
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT || "100");
const USER_COUNT = parseInt(process.env.USER_COUNT || "50");

// Fake user data (simulating popular Bluesky accounts)
const FAKE_USERS = Array.from({ length: USER_COUNT }, (_, i) => ({
  did: `did:plc:${generateFakeDid(i)}`,
  handle: `testuser${i}.bsky.social`,
  displayName: `Test User ${i}`,
}));

// Generate a fake PLC DID
function generateFakeDid(index: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 22; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result + index.toString(16).padStart(4, "0");
}

// Sample message content for variety
const MESSAGE_TEMPLATES = [
  "Hello everyone! 👋",
  "Just checking in, how's it going?",
  "Has anyone tried the new update?",
  "This is really cool!",
  "I agree with that.",
  "Interesting perspective...",
  "Thanks for sharing!",
  "Let me think about that.",
  "Great work on this!",
  "I have a question about...",
  "That makes sense.",
  "I'm not sure about that one.",
  "Can someone explain?",
  "This is exactly what I needed.",
  "Looking forward to it!",
  "Count me in! 🙌",
  "Nice! Thanks for the help.",
  "I'll look into it.",
  "That's a good point.",
  "Let's discuss this further.",
  "Anyone have experience with this?",
  "Just finished reading, good stuff.",
  "Thanks for the quick response!",
  "I'm having trouble with...",
  "Here's what I think...",
  "Appreciate the insights!",
  "This is great news!",
  "I was just thinking the same thing.",
  "Let me know when you're ready.",
  "Sure thing!",
  "No problem at all.",
  "That's awesome!",
  "I've been wondering about this too.",
  "Good question!",
  "Let's sync up later.",
  "This helps a lot, thanks!",
  "I'll give it a try.",
  "Sounds good to me!",
  "Thanks for bringing this up.",
  "That's really interesting.",
  "I'd love to help with that.",
  "Let me get back to you on this.",
  "This is super useful!",
  "I'm excited to try this out!",
  "Great timing on this.",
  "That's exactly what I was looking for.",
  "Much appreciated! 🙏",
];

const ROOM_NAMES = [
  "general", "random", "announcements", "introductions", "help",
  "development", "design", "marketing", "sales", "support",
  "feedback", "ideas", "off-topic", "events", "jobs",
  "show-and-tell", "resources", "news", "gaming", "music",
  "art", "writing", "coding", "hardware", "science",
  "politics", "sports", "food", "travel", "photography",
  "movies", "tv", "books", "comics", "anime",
  "pets", "fitness", "health", "finance", "education",
  "history", "philosophy", "religion", "humor", "memes",
  "meta", "rules", "moderation", "admin", "bots",
  "testing", "staging", "production", "alerts", "logs",
  "monitoring", "security", "privacy", "legal", "compliance",
  "documentation", "tutorials", "guides", "faq", "troubleshooting",
  "features", "bugs", "requests", "planning", "roadmap",
  "releases", "changelog", "announcements-archive", "team", "community",
  "partnerships", "integrations", "api", "webhooks", "sdks",
  "cli", "dashboard", "mobile", "desktop", "extensions",
  "plugins", "themes", "customization", "localization", "accessibility",
  "performance", "scaling", "databases", "caching", "cdn",
  "deployment", "ci-cd", "testing-automation", "coverage", "linting",
];

// Progress tracking
let eventsCreated = 0;
let roomsCreated = 0;
const startTime = Date.now();

function logProgress(message: string) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = eventsCreated > 0 ? (eventsCreated / parseFloat(elapsed)).toFixed(1) : "0";
  console.log(`[${elapsed}s | ${eventsCreated} events | ${rate} ev/s] ${message}`);
}

// Connect to Leaf with test token (matching CLI pattern)
function createLeafClient(): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = io(LEAF_URL, {
      parser,
      auth: (cb) => {
        cb({ token: LEAF_TEST_TOKEN });
      },
    });

    socket.compress(true);

    socket.on("connect", () => {
      logProgress("Connected to Leaf server");
    });

    socket.on("authenticated", (data: { did?: string }) => {
      logProgress(`Authenticated as ${data.did || "test user"}`);
      resolve(socket);
    });

    socket.on("error", (error: string) => {
      console.error("Leaf error:", error);
      reject(new Error(`Leaf authentication failed: ${error}`));
    });

    socket.on("connect_error", (error: Error) => {
      console.error("Connection error:", error.message);
      reject(error);
    });
  });
}

// Get stream info
async function getStreamInfo(socket: any, streamDid: string): Promise<{ moduleCid?: string }> {
  const req = encode({ streamDid });
  const data = await socket.emitWithAck("stream/info", Buffer.from(req));
  const resp = decode(data);
  if ("Err" in resp) {
    throw new Error(`Failed to get stream info: ${resp.Err}`);
  }
  return { moduleCid: resp.Ok.moduleCid?.$link };
}

// Convert Uint8Array to Buffer for socket.io
function toBinary(data: Uint8Array): Buffer {
  return Buffer.from(data);
}

// Send events in batch
async function sendEvents(socket: any, streamDid: string, events: Uint8Array[]): Promise<void> {
  const req = encode({
    streamDid,
    events: events.map((x) => new BytesWrapper(x)),
  });
  const data = await socket.emitWithAck("stream/event_batch", toBinary(req));
  const resp = decode(data);
  if ("Err" in resp) {
    throw new Error(`Failed to send events: ${resp.Err}`);
  }
}

// Create a room event
function createRoomEvent(roomId: string, name: string): Uint8Array {
  const event = {
    id: roomId,
    $type: "space.roomy.room.createRoom.v0",
    name,
    extensions: {},
  };
  return encode(event);
}

// Create a message event
function createMessageEvent(
  roomId: string,
  body: string,
  authorDid: string,
  replyTo?: string,
  timestamp?: number,
): Uint8Array {
  const extensions: Record<string, unknown> = {
    "space.roomy.extension.authorOverride.v0": {
      $type: "space.roomy.extension.authorOverride.v0",
      did: authorDid,
    },
  };

  if (timestamp !== undefined) {
    extensions["space.roomy.extension.timestampOverride.v0"] = {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp,
    };
  }

  const event = {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: "text/markdown",
      data: toBytes(new TextEncoder().encode(body)),
    },
    ...(replyTo ? { attachments: [{ $type: "space.roomy.attachment.reply.v0", target: replyTo }] } : {}),
    extensions,
  };

  return encode(event);
}

// Create a reaction event
function createReactionEvent(
  roomId: string,
  messageId: string,
  emoji: string,
  authorDid: string,
): Uint8Array {
  const event = {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.reaction.addBridgedReaction.v0",
    emoji,
    content: toBytes(new TextEncoder().encode(emoji)),
    messageId,
    author: authorDid,
    extensions: {
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: authorDid,
      },
    },
  };

  return encode(event);
}

// Create a user profile update event
function createProfileEvent(user: typeof FAKE_USERS[0]): Uint8Array {
  const event = {
    id: newUlid(),
    $type: "space.roomy.user.setUserProfile.v0",
    displayName: user.displayName,
    description: `This is a test user account for load testing.`,
    extensions: {
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: user.did,
      },
    },
  };

  return encode(event);
}

// Main seeding function
async function seedSpace() {
  // Validate environment
  if (!SPACE_STREAM_DID) {
    console.error("Error: SPACE_STREAM_DID environment variable is required");
    console.error("The Leaf server must already be running with a stream created.");
    console.error("\nUsage:");
    console.error("  SPACE_STREAM_DID=did:example:stream123 pnpm seed:test-space");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("Roomy Test Space Seeder");
  console.log("=".repeat(60));
  console.log(`Leaf URL: ${LEAF_URL}`);
  console.log(`Test Token: ${LEAF_TEST_TOKEN}`);
  console.log(`Stream DID: ${SPACE_STREAM_DID}`);
  console.log(`Target events: ${EVENT_COUNT.toLocaleString()}`);
  console.log(`Rooms to create: ${ROOM_COUNT}`);
  console.log(`Fake users: ${USER_COUNT}`);
  console.log("=".repeat(60));

  // Connect to Leaf
  logProgress("Connecting to Leaf server...");
  const socket = await createLeafClient();

  // Verify stream exists
  logProgress(`Verifying stream ${SPACE_STREAM_DID}...`);
  try {
    await getStreamInfo(socket, SPACE_STREAM_DID);
    logProgress("Stream verified");
  } catch (e) {
    console.error("Failed to verify stream:", e);
    console.error("\nMake sure the Leaf server is running and the stream exists.");
    process.exit(1);
  }

  // Generate room IDs
  const roomIds = Array.from({ length: ROOM_COUNT }, () => newUlid());

  // Prepare events batch
  const allEvents: Uint8Array[] = [];
  const BATCH_SIZE = 100;
  let lastLogTime = Date.now();

  // Phase 1: Create profile events for all fake users
  logProgress("Phase 1: Creating user profiles...");
  for (const user of FAKE_USERS) {
    allEvents.push(createProfileEvent(user));
    eventsCreated++;

    if (allEvents.length >= BATCH_SIZE) {
      await sendEvents(socket, SPACE_STREAM_DID, allEvents);
      allEvents.length = 0;

      if (Date.now() - lastLogTime > 1000) {
        logProgress(`Created ${eventsCreated} profile events`);
        lastLogTime = Date.now();
      }
    }
  }

  // Phase 2: Create rooms
  logProgress("Phase 2: Creating rooms...");
  for (let i = 0; i < ROOM_COUNT; i++) {
    const roomName = ROOM_NAMES[i % ROOM_NAMES.length] + (i >= ROOM_NAMES.length ? `-${i}` : "");
    allEvents.push(createRoomEvent(roomIds[i], roomName));
    eventsCreated++;
    roomsCreated++;

    if (allEvents.length >= BATCH_SIZE) {
      await sendEvents(socket, SPACE_STREAM_DID, allEvents);
      allEvents.length = 0;

      if (Date.now() - lastLogTime > 1000) {
        logProgress(`Created ${roomsCreated} rooms`);
        lastLogTime = Date.now();
      }
    }
  }

  // Phase 3: Fill rooms with messages
  logProgress("Phase 3: Creating messages...");
  const messagesPerRoom = Math.floor((EVENT_COUNT - eventsCreated) / ROOM_COUNT);
  const baseTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  for (let roomIdx = 0; roomIdx < ROOM_COUNT; roomIdx++) {
    const roomId = roomIds[roomIdx];
    const messageIds: string[] = [];

    // Create messages for this room
    for (let msgIdx = 0; msgIdx < messagesPerRoom; msgIdx++) {
      const user = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
      const template = MESSAGE_TEMPLATES[Math.floor(Math.random() * MESSAGE_TEMPLATES.length)];
      const timestamp = baseTimestamp + (roomIdx * messagesPerRoom + msgIdx) * 1000;

      // Some messages are replies
      let replyTo: string | undefined;
      if (messageIds.length > 0 && Math.random() < 0.2) {
        replyTo = messageIds[Math.floor(Math.random() * messageIds.length)];
      }

      const event = createMessageEvent(roomId, template, user.did, replyTo, timestamp);
      allEvents.push(event);
      // Extract the message ID from the encoded event
      const decoded = decode(event);
      messageIds.push(decoded.id as string);
      eventsCreated++;

      if (allEvents.length >= BATCH_SIZE) {
        await sendEvents(socket, SPACE_STREAM_DID, allEvents);
        allEvents.length = 0;

        if (Date.now() - lastLogTime > 1000) {
          logProgress(`Room ${roomIdx + 1}/${ROOM_COUNT}: ${eventsCreated} total events`);
          lastLogTime = Date.now();
        }
      }
    }
  }

  // Send remaining events
  if (allEvents.length > 0) {
    await sendEvents(socket, SPACE_STREAM_DID, allEvents);
  }

  // Phase 4: Add some reactions
  logProgress("Phase 4: Adding reactions...");
  const reactionsPerRoom = 50;
  for (let roomIdx = 0; roomIdx < Math.min(ROOM_COUNT, 50); roomIdx++) {
    const roomId = roomIds[roomIdx];

    for (let r = 0; r < reactionsPerRoom; r++) {
      const user = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
      const emoji = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👏"][Math.floor(Math.random() * 8)];
      // Use a message ID that would exist (not real but tests the structure)
      const messageId = newUlid();

      allEvents.push(createReactionEvent(roomId, messageId, emoji, user.did));
      eventsCreated++;

      if (allEvents.length >= BATCH_SIZE) {
        await sendEvents(socket, SPACE_STREAM_DID, allEvents);
        allEvents.length = 0;
      }
    }

    if (Date.now() - lastLogTime > 1000) {
      logProgress(`Added reactions to room ${roomIdx + 1}/${Math.min(ROOM_COUNT, 50)}`);
      lastLogTime = Date.now();
    }
  }

  // Send final batch
  if (allEvents.length > 0) {
    await sendEvents(socket, SPACE_STREAM_DID, allEvents);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = (eventsCreated / parseFloat(elapsed)).toFixed(1);

  console.log("=".repeat(60));
  console.log("Seeding complete!");
  console.log("=".repeat(60));
  console.log(`Total events created: ${eventsCreated.toLocaleString()}`);
  console.log(`Rooms created: ${roomsCreated.toLocaleString()}`);
  console.log(`Time elapsed: ${elapsed}s`);
  console.log(`Average rate: ${rate} events/second`);
  console.log("=".repeat(60));

  socket.disconnect();
}

// Run the seeder
seedSpace().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
