<script lang="ts">
  import { goto } from "$app/navigation";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconForward, IconHashtag } from "@roomy/design/icons";
  import { createMessageQuery } from "$lib/queries/message";
  import type { Message } from "$lib/queries/messages";
  import { resolveBlobUrl } from "$lib/utils";
  import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";

  type ForwardedFrom = NonNullable<Message["forwardedFrom"]>;

  let {
    forwardedFrom,
  }: {
    /** The original message this forward embeds. */
    forwardedFrom: ForwardedFrom;
  } = $props();

  // The original lives in its own room (`forwardedFrom.roomId`), so fetch it
  // by id + source room. Hydrates from the room cache when already on screen.
  const target = createMessageQuery(
    () => forwardedFrom.messageId,
    () => forwardedFrom.roomId,
  );

  const preview = $derived.by(() => {
    const t = target.data;
    if (!t) return "";
    if (t.mimeType === RICHTEXT_MIME) {
      try {
        return blocksToPlaintext(JSON.parse(t.content).blocks ?? []);
      } catch {
        return "";
      }
    }
    return t.content ?? "";
  });

  let isBridged = $derived(
    target.data?.authorDid?.startsWith("did:discord:") ?? false,
  );
</script>

<div
  class="not-prose max-w-[70ch] rounded-lg border border-base-400/60 dark:border-base-800 bg-base-100/50 dark:bg-base-900/50 px-3 py-2 flex flex-col gap-1 overflow-hidden"
>
  <div class="flex items-center gap-1.5 text-xs text-base-500 dark:text-base-400">
    <IconForward class="size-3.5 shrink-0" />
    <span class="truncate">Forwarded from</span>
    <IconHashtag class="size-3 shrink-0" />
    <span class="truncate font-medium">{forwardedFrom.name || "a room"}</span>
  </div>

  {#if target.data}
    <div class="flex items-center gap-1.5 min-w-0">
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
        <span class="font-medium text-accent-700 dark:text-accent-300 truncate">
          {target.data.authorName || target.data.authorDid.slice(0, 12)}
        </span>
      {:else}
        <a
          href={`/user/${target.data.authorDid}`}
          class="font-medium text-accent-700 dark:text-accent-300 hover:underline truncate"
        >
          {target.data.authorName || target.data.authorDid.slice(0, 12)}
        </a>
      {/if}
    </div>
    <div class="line-clamp-2 overflow-hidden text-sm text-base-700 dark:text-base-300">
      {preview || "…"}
    </div>
  {:else if target.isPending}
    <div class="h-5"></div>
  {:else}
    <span class="italic text-base-400 text-sm">Original message unavailable</span>
  {/if}
</div>
