import {
  RICHTEXT_MIME,
  deserializeBody,
  type Block,
} from "@roomy-space/sdk";

/**
 * Content decoding utilities for the appserver SQLite schema.
 *
 * Message content is stored as a blob (`comp_content.data`) with an
 * associated mime type. This module provides a shared decoder that
 * all query files should use, rather than re-implementing the same
 * logic in multiple places.
 */

/**
 * Decode message content from the DB blob.
 *
 * - text/* and application/json → UTF-8 string
 * - everything else → base64 (so the wire format stays JSON-safe)
 * - null data → empty string
 */
export function decodeContent(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (data === null) return "";
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  if (!mime || mime.startsWith("text/") || mime === "application/json") {
    return buf.toString("utf8");
  }
  return buf.toString("base64");
}

/**
 * Decode a rich-text (blocks + facets) message body from the DB blob.
 *
 * Returns the parsed `Block[]` for the new-format mime type
 * (`application/vnd.roomy.richtext+json`), or `null` for legacy mime types
 * and for bodies that fail to parse. Structured consumers (embed link
 * detection, mention extraction, push plaintext) use this instead of
 * {@link decodeContent}, which stays the string form for the wire
 * `content` field.
 */
export function decodeRichTextBody(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): Block[] | null {
  if (mime !== RICHTEXT_MIME) return null;
  const buf = data === null ? null : data instanceof Buffer ? data : Buffer.from(data);
  const result = deserializeBody(mime, buf);
  return Array.isArray(result) ? result : null;
}