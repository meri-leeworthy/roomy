import { newUlid, toBytes, transport, utf8ByteLength } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

export interface MessageInfo {
  id: string;
  authorDid: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface SendOptions {
  /** Rich-text blocks body (new format). When set, `text` is ignored and the
   *  wire body is the blocks+facets document. */
  blocks?: Block[];
  /** ID of a message to reply to. Creates a thread rooted at that message. */
  parent?: string;
}

/**
 * Send a message to a room via sendEvents.
 */
export async function sendMessage(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  text: string,
  opts: SendOptions = {},
): Promise<{ messageId: string }> {
  const messageId = newUlid();
  const body = opts.blocks
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(
          new TextEncoder().encode(
            JSON.stringify({
              $type: "space.roomy.richtext.document",
              blocks: opts.blocks,
            }),
          ),
        ),
      }
    : {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(text)),
      };

  const event = {
    id: messageId,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0" as const,
    body,
    extensions: opts.parent
      ? {
          "space.roomy.extension.attachments.v0": {
            attachments: [
              { $type: "space.roomy.attachment.reply.v0", target: opts.parent },
            ],
          },
        }
      : {},
  };

  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [event],
  });

  return { messageId };
}

/**
 * Build a rich-text message body that mentions a user via a `#didMention`
 * facet — the Roomy-native mention (renders as a mention chip, not plain
 * text). The label is folded into the block text as `@label` and the facet
 * covers that byte range, matching how the app UI serializes mentions.
 */
export function buildMentionBlocks(
  text: string,
  did: string,
  label: string,
): Block[] {
  const mention = `@${label}`;
  const full = `${mention} ${text}`.trim();
  return [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: full,
      facets: [
        {
          index: { byteStart: 0, byteEnd: utf8ByteLength(mention) },
          features: [
            { $type: "space.roomy.richtext.facet#didMention", did },
          ],
        },
      ],
    },
  ];
}

/**
 * Read messages from a room.
 */
export async function readMessages(
  xrpc: DirectXrpcClient,
  roomId: string,
  limit: number = 20,
): Promise<MessageInfo[]> {
  const result = await xrpc.query("space.roomy.room.getMessages", {
    roomId,
    ...(limit !== 20 ? { limit: String(limit) } : {}),
  });

  return result.messages.map((m) => ({
    id: m.id,
    authorDid: m.authorDid,
    authorName: m.authorName,
    content: m.content,
    timestamp: m.timestamp,
  }));
}
