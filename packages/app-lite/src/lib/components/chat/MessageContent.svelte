<script lang="ts">
  import { renderMarkdownSanitized } from "@roomy/design/utils";
  import { enrichInternalLinks } from "./enrich-internal-links";
  import { parseRichTextContent } from "./enrich-internal-links";
  import BlocksRenderer from "./BlocksRenderer.svelte";
  import { RICHTEXT_MIME } from "@roomy-space/sdk";

  let {
    content,
    mimeType,
  }: {
    /** Message content to render. Markdown for legacy messages, base64-encoded
     *  richtext JSON for `application/vnd.roomy.richtext+json` messages. */
    content: string;
    /** MIME type of the content blob. Absent → legacy markdown path. */
    mimeType?: string;
  } = $props();

  // New format: content is base64-encoded JSON of the blocks document
  // (the appserver's decodeContent base64-encodes non-text mimeTypes).
  // Parse once; on any failure fall back to the legacy markdown path.
  const blocks = $derived(
    mimeType === RICHTEXT_MIME ? parseRichTextContent(content) : null,
  );
</script>

{#if blocks}
  <BlocksRenderer {blocks} />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div use:enrichInternalLinks class="roomy-message-content">
    {@html renderMarkdownSanitized(content)}
  </div>
{/if}

<style>
  /*
    The wrapper host sits between `.prose` (in MessageBubble) and the rendered
    markdown, so it breaks the `.prose > :first-child` / `> :last-child` margin
    resets that Tailwind Typography applies to flush the first/last paragraph
    with the bubble. The wrapper itself is display:contents (no box), so
    re-apply those resets through it to keep message text flush.
  */
  .roomy-message-content {
    display: contents;
  }
  :global(.prose > .roomy-message-content > :first-child) {
    margin-top: 0;
  }
  :global(.prose > .roomy-message-content > :last-child) {
    margin-bottom: 0;
  }
</style>