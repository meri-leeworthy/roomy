<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconForward } from "@roomy/design/icons";
  import { formatMessageTimestamp } from "@roomy/design/utils";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    name,
    handle,
    avatar,
    did,
    timestamp,
  }: {
    /** The forwarding user's display name. */
    name?: string;
    /** The forwarding user's handle. */
    handle?: string;
    /** The forwarding user's avatar URL (blob or resolved). */
    avatar?: string;
    /** The forwarding user's DID. */
    did?: string;
    /** When the message was forwarded. */
    timestamp: Date;
  } = $props();
</script>

<div class="flex items-center gap-1.5 text-sm text-base-500 dark:text-base-400 pl-0.5">
  <IconForward class="size-3.5 shrink-0 text-base-400 dark:text-base-500" />
  {#if did || avatar}
    <span class="w-4 h-4 rounded-full shrink-0">
      <UserAvatar
        src={resolveBlobUrl(avatar)}
        name={did || name || "unknown"}
        size={16}
        class="w-4 h-4"
      />
    </span>
  {/if}
  <span class="font-medium text-base-700 dark:text-base-300 truncate">
    {name || (handle ? `@${handle}` : did?.slice(0, 12))}
  </span>
  {#if handle}
    <span class="opacity-75 truncate">@{handle}</span>
  {/if}
  <span class="shrink-0">forwarded</span>
  <time class="shrink-0 text-[13px] opacity-70">{formatMessageTimestamp(timestamp)}</time>
</div>
