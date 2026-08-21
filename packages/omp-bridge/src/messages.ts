import { newUlid, toBytes, transport, utf8ByteLength, deserializeBody, blocksToPlaintext, extractMentionDids } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";

type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/** A message as delivered by the appserver sync frames. */
export interface IncomingMessage {
  id: string;
  roomId: string;
  authorDid: string;
  authorName: string;
  content: string;
  mimeType?: string;
  timestamp: string;
}

export interface AgentIdentity {
  agentDid: string;
  agentHandle: string;
  agentName: string;
}

/** Prefix marking a thinking-trace message, so consumers can filter the noise
 *  out of context (and out of inter-agent communication). */
export const THINKING_MARKER = "💭";

/**
 * Post a reply to a room as the bridge's own message. Builds the createMessage
 * event directly (the bridge owns its own posting path; it doesn't reuse the
 * CLI's send command).
 *
 * `blocks` is an optional rich-text body. When omitted the reply is sent as
 * plain text/markdown.
 */
export async function sendReply(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  text: string,
  blocks?: Block[],
  parent?: string,
): Promise<{ messageId: string }> {
  const messageId = newUlid();
  const body = blocks && blocks.length > 0
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(
          new TextEncoder().encode(
            JSON.stringify({
              $type: "space.roomy.richtext.document",
              blocks,
            }),
          ),
        ),
      }
    : {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(text)),
      };

  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [
      {
        id: messageId,
        room: roomId,
        $type: "space.roomy.message.createMessage.v0",
        body,
        // When the agent is replying to a mention, thread the reply under the
        // parent so all task chatter stays in that thread (not the room root).
        extensions: parent
          ? {
              "space.roomy.extension.attachments.v0": {
                attachments: [
                  { $type: "space.roomy.attachment.reply.v0", target: parent },
                ],
              },
            }
          : {},
      },
    ],
  });

  return { messageId };
}

/**
 * Build the rich-text blocks for the agent's reply: an optional thinking
 * blockquote followed by the answer as normal text. Always includes the answer
 * so the reply is never an empty document.
 */
export function buildReplyBlocks(answer: string, thinking?: string): Block[] {
  const blocks: Block[] = [];
  if (thinking) {
    blocks.push({
      $type: "space.roomy.richtext.blocks#blockquote",
      text: `${THINKING_MARKER} ${thinking}`,
    });
  }
  blocks.push({
    $type: "space.roomy.richtext.blocks#text",
    text: answer,
  });
  return blocks;
}

/** Build a single blockquote block carrying a chunk of the thinking trace. */
export function buildThinkingBlocks(thinking: string): Block[] {
  return [
    {
      $type: "space.roomy.richtext.blocks#blockquote",
      text: `${THINKING_MARKER} ${thinking}`,
    },
  ];
}

/**
 * Decide whether a message mentions the agent. The DID is authoritative (a
 * `#didMention` facet is a stable, unambiguous match); plain-text matching is a
 * best-effort fallback for messages not authored with a rich mention.
 */
export function isMentioned(msg: IncomingMessage, identity: AgentIdentity): boolean {
  const { agentDid, agentHandle, agentName } = identity;
  const mime = msg.mimeType ?? "";

  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) {
        const dids = extractMentionDids(blocks);
        if (dids.includes(agentDid)) return true;
      }
    } catch {
      // fall through to text matching
    }
  }

  // Strict fallback: only an explicit @Name / @handle / @did mention counts.
  // A bare substring of the agent's name (e.g. "Chanterelle" appearing in a
  // report, thinking trace, or forwarded message) must NOT trigger the agent.
  const text = msg.content ?? "";
  const needles = [agentName, agentHandle, agentDid].filter(Boolean);
  return needles.some((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Multi-word names (e.g. "Little Fox"): allow whitespace between words
    // after the leading @, so `@Little Fox` and `@Little\nFox` both match.
    const spaced = esc.replace(/\\ /g, "\\s*");
    return new RegExp(`@${spaced}(?![\\w-])`, "i").test(text);
  });
}

/** Extract plain text from a message regardless of mime type. */
export function plaintext(msg: IncomingMessage): string {
  const mime = msg.mimeType ?? "";
  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) return blocksToPlaintext(blocks);
    } catch {
      // fall through
    }
  }
  return msg.content ?? "";
}

/** The appserver base64-encodes non-text content blobs (e.g. richtext JSON) on
 * the wire; decode back to bytes before parsing. */
function decodeContentBytes(content: string): Uint8Array {
  return Buffer.from(content, "base64");
}

/** Build a rich-text body that mentions a user via a `#didMention` facet. */
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
