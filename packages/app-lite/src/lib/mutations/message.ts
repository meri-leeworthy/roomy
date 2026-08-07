import { newUlid, toBytes } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function sendMessage(
  spaceId: string,
  roomId: string,
  body: string,
  opts: {
    mimeType?: string;
    replyTo?: string;
    mentions?: string[];
    /** Blocks+facets body (new format). When set, `body` is ignored and the
     *  wire body is `serializeBlocks(blocks)`; the mentions sidecar is
     *  dropped (mentions fold into `#didMention` facets). */
    blocks?: Block[];
  } = {},
): Promise<string> {
  const id = newUlid();
  const attachments = opts.replyTo
    ? [
        {
          $type: "space.roomy.attachment.reply.v0",
          target: opts.replyTo,
        },
      ]
    : undefined;

  const extensions: Record<string, unknown> = {};
  if (opts.blocks) {
    // New format: mentions live in `#didMention` facets — no sidecar.
  } else if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }

  const wireBody = opts.blocks
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(new TextEncoder().encode(JSON.stringify({
          $type: "space.roomy.richtext.document",
          blocks: opts.blocks,
        }))),
      }
    : {
        mimeType: opts.mimeType || "text/markdown",
        data: toBytes(new TextEncoder().encode(body)),
      };

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: wireBody,
    extensions,
    ...(attachments ? { attachments } : {}),
  };

  await sendEvents(spaceId, [event]);
  return id;
}

export async function editMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
  body: string,
  opts: {
    mimeType?: string;
    mentions?: string[];
    /** Blocks+facets body (new format). When set, `body` is ignored and the
     *  wire body is `serializeBlocks(blocks)`; the mentions sidecar is
     *  dropped (mentions fold into `#didMention` facets). */
    blocks?: Block[];
  } = {},
): Promise<string> {
  const id = newUlid();
  const extensions: Record<string, unknown> = {};
  if (opts.blocks) {
    // New format: mentions live in `#didMention` facets — no sidecar.
  } else if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }

  const wireBody = opts.blocks
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(new TextEncoder().encode(JSON.stringify({
          $type: "space.roomy.richtext.document",
          blocks: opts.blocks,
        }))),
      }
    : {
        mimeType: opts.mimeType ?? "text/markdown",
        data: toBytes(new TextEncoder().encode(body)),
      };

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.editMessage.v0",
    messageId,
    body: wireBody,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  await sendEvents(spaceId, [event]);
  return id;
}

export async function deleteMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
): Promise<string> {
  const id = newUlid();
  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId,
  };

  await sendEvents(spaceId, [event]);
  return id;
}
