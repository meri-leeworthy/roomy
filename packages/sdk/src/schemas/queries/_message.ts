/**
 * Shared Message schema, used by both `room.getMessages` and
 * `message.getMessage` responses, and by the `#messageDiff` WS frame.
 * Mirrors packages/appserver/src/queries/selectMessages.ts MessageDto.
 *
 * The schemas live in an arktype `scope` so `Message` and `ForwardedFrom`
 * can reference each other: a forward's `forwardedFrom.message` is itself a
 * full `Message` (fully denormalised server-side, including its own
 * `forwardedFrom` chain for nested forwards).
 */
import { scope } from "arktype";

const Schemas = scope({
  Reaction: {
    emoji: "string",
    count: "number",
    /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
    "myReactionId?": "string",
  },

  Media: {
    url: "string",
    type: "string",
    "alt?": "string",
    "width?": "number",
    "height?": "number",
    "blurhash?": "string",
    "size?": "number",
    "length?": "number",
    "name?": "string",
  },

  /**
   * Metadata for a forward: where the original lives, plus the fully
   * denormalised original message itself (`message`), which the client
   * renders directly — no extra fetch needed.
   */
  ForwardedFrom: {
    /** The ID of the original message that was forwarded. */
    messageId: "string",
    /** The room the original message lives in. */
    roomId: "string",
    /** The name of the source room. */
    name: "string",
    /**
     * The fully denormalised original message (author, content, timestamp,
     * reactions, media, linkEmbeds, and its own `forwardedFrom` chain when
     * the original is itself a forward). Absent when the original couldn't
     * be resolved (e.g. deleted or not yet materialised).
     */
    "message?": "Message",
  },

  /**
   * A link embed with optional enriched metadata from the embed service.
   * The `embed` field contains the EmbedV1 JSON object when enrichment has
   * completed; it's absent/null when still pending or when the service had
   * no data for the URL.
   *
   * The embed data follows the Lantern-chat embed-service protocol:
   * https://github.com/Lantern-chat/embed-service
   */
  LinkEmbedData: {
    "t?": "string",
    "d?": "string",
    /** Provider info from oEmbed. */
    "p?": { "n?": "string", "u?": "string" },
    /** Author info from OpenGraph. */
    "au?": { "n?": "string", "u?": "string" },
    /** Footer text. */
    "footer?": { "t?": "string" },
    /** Minimal media reference within an embed (image, video, thumbnail). */
    "imgs?": "EmbedMedia[]",
    "vid?": "EmbedMedia",
    "thumb?": "EmbedMedia",
  },

  /** Minimal media reference within an embed (image, video, thumbnail). */
  EmbedMedia: {
    u: "string",
    "d?": "string",
    "w?": "number",
    "h?": "number",
    "m?": "string",
  },

  LinkEmbed: {
    url: "string",
    "embed?": "LinkEmbedData",
  },

  Message: {
    id: "string",
    /** Sort index for timeline ordering. ULID based on canonical timestamp. */
    "sort_idx?": "string",
    content: "string",
    /**
     * MIME type of the content blob. `text/markdown` for legacy messages,
     * `application/vnd.roomy.richtext+json` for blocks+facets messages.
     * Clients branch rendering on this.
     */
    "mimeType?": "string",
    authorDid: "string",
    authorName: "string",
    "authorHandle?": "string",
    "authorAvatar?": "string",
    /**
     * True for system messages (e.g. "X joined the space", "X created
     * [thread]") — authored by the space itself. The author line is not
     * meaningful for these; clients should hide the author identity.
     */
    "system?": "boolean",
    timestamp: "string",
    "replyTo?": "string",
    "forwardedFrom?": "ForwardedFrom",
    reactions: "Reaction[]",
    media: "Media[]",
    /** Link embeds with enriched metadata from the embed service. */
    linkEmbeds: "LinkEmbed[]",
  },
}).export();

export const Reaction = Schemas.Reaction;
export const Media = Schemas.Media;
export const ForwardedFrom = Schemas.ForwardedFrom;
export const LinkEmbedData = Schemas.LinkEmbedData;
export const LinkEmbed = Schemas.LinkEmbed;
export const Message = Schemas.Message;
