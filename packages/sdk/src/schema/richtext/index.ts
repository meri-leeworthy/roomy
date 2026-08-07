/**
 * Rich text block + facet types (the `space.roomy.richtext.*` model).
 *
 * Mirrors the ATProto lexicon definitions under
 * `packages/appserver/lexicons/space/roomy/richtext/`:
 *   - `document` — the root record: `{ $type, blocks }`
 *   - `blocks`   — the open block union (`#text`, `#header`, `#blockquote`,
 *                  `#code`, `#orderedList`, `#unorderedList`, `#image`,
 *                  `#horizontalRule`)
 *   - `facet`    — byte-indexed annotations with an open feature union
 *                  (`#bold`, `#italic`, `#strikethrough`, `#underline`,
 *                  `#code`, `#highlight`, `#link`, `#didMention`,
 *                  `#atMention`, `#roomRef`)
 *
 * Facet indices are UTF-8 byte offsets (`byteStart` inclusive, `byteEnd`
 * exclusive) matching `app.bsky.richtext.facet#byteSlice`. JS callers must
 * convert UTF-16 string offsets to byte offsets — see the converter module
 * (`src/richtext/convert.ts`).
 */

import { type } from "arktype";

/** A byte range into a block's `text`, UTF-8 encoded. */
export const ByteSlice = type({
  byteStart: "number.integer>=0",
  byteEnd: "number.integer>=0",
}).describe("A UTF-8 byte range into the block text: start inclusive, end exclusive.");
export type ByteSlice = typeof ByteSlice.infer;

// ─── Facet features (open union) ─────────────────────────────────────────

export const BoldFeature = type({
  $type: "'space.roomy.richtext.facet#bold'",
});
export type BoldFeature = typeof BoldFeature.infer;

export const ItalicFeature = type({
  $type: "'space.roomy.richtext.facet#italic'",
});
export type ItalicFeature = typeof ItalicFeature.infer;

export const StrikethroughFeature = type({
  $type: "'space.roomy.richtext.facet#strikethrough'",
});
export type StrikethroughFeature = typeof StrikethroughFeature.infer;

export const UnderlineFeature = type({
  $type: "'space.roomy.richtext.facet#underline'",
});
export type UnderlineFeature = typeof UnderlineFeature.infer;

export const CodeFeature = type({
  $type: "'space.roomy.richtext.facet#code'",
});
export type CodeFeature = typeof CodeFeature.infer;

export const HighlightFeature = type({
  $type: "'space.roomy.richtext.facet#highlight'",
});
export type HighlightFeature = typeof HighlightFeature.infer;

export const LinkFeature = type({
  $type: "'space.roomy.richtext.facet#link'",
  uri: "string",
});
export type LinkFeature = typeof LinkFeature.infer;

export const DidMentionFeature = type({
  $type: "'space.roomy.richtext.facet#didMention'",
  did: "string",
});
export type DidMentionFeature = typeof DidMentionFeature.infer;

export const AtMentionFeature = type({
  $type: "'space.roomy.richtext.facet#atMention'",
  uri: "string",
});
export type AtMentionFeature = typeof AtMentionFeature.infer;

export const RoomRefFeature = type({
  $type: "'space.roomy.richtext.facet#roomRef'",
  spaceId: "string",
  "roomId?": "string",
});
export type RoomRefFeature = typeof RoomRefFeature.infer;

/**
 * Catch-all for unknown facet feature `$type`s. Unknown features are
 * tolerated by consumers (the plain `text` carries through) — this is the
 * "open union" guarantee.
 */
export const UnknownFeature = type({
  $type: "string",
});
export type UnknownFeature = typeof UnknownFeature.infer;

/**
 * Open union of facet features. Unknown feature `$type`s are tolerated by
 * consumers (rendered as plain text).
 */
export const FacetFeature = type.or(
  BoldFeature,
  ItalicFeature,
  StrikethroughFeature,
  UnderlineFeature,
  CodeFeature,
  HighlightFeature,
  LinkFeature,
  DidMentionFeature,
  AtMentionFeature,
  RoomRefFeature,
  UnknownFeature,
);
export type FacetFeature = typeof FacetFeature.infer;

/** One annotation over a byte range of a block's `text`. */
export const Facet = type({
  index: ByteSlice,
  features: FacetFeature.array(),
}).describe("An annotation over a byte range of a block's text.");
export type Facet = typeof Facet.infer;

// ─── Blocks (open union) ─────────────────────────────────────────────────

export const TextBlock = type({
  $type: "'space.roomy.richtext.blocks#text'",
  text: "string",
  "facets?": Facet.array(),
});
export type TextBlock = typeof TextBlock.infer;

export const HeaderBlock = type({
  $type: "'space.roomy.richtext.blocks#header'",
  text: "string",
  "facets?": Facet.array(),
  level: "1<=number.integer<=6",
});

export const BlockquoteBlock = type({
  $type: "'space.roomy.richtext.blocks#blockquote'",
  text: "string",
  "facets?": Facet.array(),
});
export type BlockquoteBlock = typeof BlockquoteBlock.infer;

export const CodeBlock = type({
  $type: "'space.roomy.richtext.blocks#code'",
  text: "string",
  "language?": "string",
});
export type CodeBlock = typeof CodeBlock.infer;

export const ListItem = type({
  text: "string",
  "facets?": Facet.array(),
});
export type ListItem = typeof ListItem.infer;

export const OrderedListBlock = type({
  $type: "'space.roomy.richtext.blocks#orderedList'",
  items: ListItem.array(),
});
export type OrderedListBlock = typeof OrderedListBlock.infer;

export const UnorderedListBlock = type({
  $type: "'space.roomy.richtext.blocks#unorderedList'",
  items: ListItem.array(),
});
export type UnorderedListBlock = typeof UnorderedListBlock.infer;

export const ImageBlock = type({
  $type: "'space.roomy.richtext.blocks#image'",
  uri: "string",
  "alt?": "string",
  "width?": "number.integer>=0",
  "height?": "number.integer>=0",
});
export type ImageBlock = typeof ImageBlock.infer;

export const HorizontalRuleBlock = type({
  $type: "'space.roomy.richtext.blocks#horizontalRule'",
});
export type HorizontalRuleBlock = typeof HorizontalRuleBlock.infer;

/**
 * Catch-all for unknown block `$type`s. Unknown blocks are dropped by
 * renderers (their `text` is lost unless the block carries one) — this is
 * the "open union" guarantee.
 */
export const UnknownBlock = type({
  $type: "string",
  "text?": "string",
});
export type UnknownBlock = typeof UnknownBlock.infer;

/**
 * Open union of block types. Unknown block `$type`s are dropped by
 * renderers (their `text` is lost unless the block carries one).
 */
export const Block = type.or(
  TextBlock,
  HeaderBlock,
  BlockquoteBlock,
  CodeBlock,
  OrderedListBlock,
  UnorderedListBlock,
  ImageBlock,
  HorizontalRuleBlock,
  UnknownBlock,
);
export type Block = typeof Block.infer;

/** The root rich-text document record. */
export const RichTextDocument = type({
  $type: "'space.roomy.richtext.document'",
  blocks: Block.array(),
}).describe("A rich text document: an ordered array of blocks.");
export type RichTextDocument = typeof RichTextDocument.infer;

/** Type guard: does the value validate as a RichTextDocument? */
export function isRichTextDocument(v: unknown): v is RichTextDocument {
  const result = RichTextDocument(v);
  return !(result instanceof type.errors);
}
