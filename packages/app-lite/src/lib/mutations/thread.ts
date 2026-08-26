import { newUlid, toBytes } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";
import { createRoom } from "./room";

/**
 * Create a thread from selected messages.
 * 1. Creates a new "space.roomy.thread" room
 * 2. Links it to the parent room
 * 3. Forwards each selected message into the thread (originals stay in place)
 *
 * Forwards use the modern representation: a `createMessage` event carrying a
 * `space.roomy.attachment.forward.v0` attachment (a real message with an
 * empty body — a forward without commentary), mirroring `forwardMessage`.
 * All events are batched into a single sendEvents call.
 */
export async function createThread({
  spaceId,
  parentRoomId,
  threadName,
  messageIds,
}: {
  spaceId: string;
  parentRoomId: string;
  threadName: string;
  messageIds: string[];
}): Promise<string> {
  // 1. Create the thread room
  const threadId = await createRoom(spaceId, {
    kind: "space.roomy.thread",
    name: threadName,
  });

  // 2. Build link + forward events
  const events: Array<Record<string, unknown>> = [];

  // Link from parent → thread
  events.push({
    id: newUlid(),
    room: parentRoomId,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: threadId,
    isCreationLink: true,
  });

  // Forward each selected message into the thread. The original message stays
  // in the parent room; a forward message (empty body + forward attachment)
  // is created in the thread, embedding the original.
  for (const msgId of messageIds) {
    events.push({
      id: newUlid(),
      room: threadId,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode("")),
      },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            {
              $type: "space.roomy.attachment.forward.v0",
              target: msgId,
              fromRoomId: parentRoomId,
            },
          ],
        },
      },
    });
  }

  await sendEvents(spaceId, events);
  return threadId;
}
