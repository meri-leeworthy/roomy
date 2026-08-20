<script lang="ts">
  import { goto } from "$app/navigation";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconReplyLine, IconForward } from "@roomy/design/icons";
  import { createMessageQuery } from "$lib/queries/message";
  import { resolveBlobUrl } from "$lib/utils";
  import { messageContentToPlaintext } from "./messagePreview";

  type Props = {
    replyToId: string;
    roomId: string;
  };

  let { replyToId, roomId }: Props = $props();

  const target = createMessageQuery(() => replyToId, () => roomId);

  // If the message being replied to is a forward, its own content is the
  // forwarder's (often-empty) note; the message the forwarder embedded lives
  // in another room. Show the original's content as the reply preview.
  const forwardedFrom = $derived(target.data?.forwardedFrom);
  const original = createMessageQuery(
    () => forwardedFrom?.messageId ?? "",
    () => forwardedFrom?.roomId ?? "",
    { enabled: !!forwardedFrom },
  );
  const previewContent = $derived(
    original.data?.content ?? target.data?.content ?? "",
  );
  const previewMime = $derived(
    original.data?.mimeType ?? target.data?.mimeType,
  );

  let isBridged = $derived(target.data?.authorDid?.startsWith("did:discord:") ?? false);
</script>

{#if target.data}
  <div class="flex gap-1 items-center shrink-0">
    <IconReplyLine
      width="28px"
      height="12px"
      class="relative -bottom-1 ml-2 mr-1 left-0.75 stroke-black/25 dark:stroke-white/50 dark:stroke-1"
    />
    {#if target.data.authorAvatar || target.data.authorDid}
      {#if isBridged}
        <div class="w-4 h-4 rounded-full shrink-0">
          <UserAvatar
            src={resolveBlobUrl(target.data.authorAvatar)}
            name={target.data.authorDid || ""}
            size={16}
            class="w-4 h-4"
          />
        </div>
      {:else}
        <button
          onclick={() => goto(`/user/${target.data.authorDid}`)}
          class="w-4 h-4 rounded-full shrink-0 hover:ring-2 hover:ring-accent-500 transition-all cursor-pointer"
        >
          <UserAvatar
            src={resolveBlobUrl(target.data.authorAvatar)}
            name={target.data.authorDid || ""}
            size={16}
            class="w-4 h-4"
          />
        </button>
      {/if}
    {/if}
    {#if isBridged}
      <span
        class="font-medium text-accent-700 dark:text-accent-300"
      >
        {target.data.authorName || target.data.authorDid.slice(0, 12)}
      </span>
    {:else}
      <a
        href={`/user/${target.data.authorDid}`}
        class="font-medium text-accent-700 dark:text-accent-300 hover:underline"
      >
        {target.data.authorName || target.data.authorDid.slice(0, 12)}
      </a>
    {/if}
  </div>
  <div class="flex items-center gap-1 italic">
    {#if forwardedFrom}
      <IconForward class="size-3.5 shrink-0 text-base-500 dark:text-base-400" />
    {/if}
    <span class="line-clamp-1 overflow-hidden">
      {@html messageContentToPlaintext(previewContent, previewMime)}
    </span>
  </div>
{:else if target.isPending}
  <div class="h-5"></div>
{:else}
  <span class="italic text-base-400">Reply unavailable</span>
{/if}
