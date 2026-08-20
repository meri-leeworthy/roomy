<script lang="ts">
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconForward } from "@roomy/design/icons";
  import { formatMessageTimestamp } from "@roomy/design/utils";
  import { resolveBlobUrl } from "$lib/utils";

  let {
    name,
    did,
    avatar,
    timestamp,
  }: {
    /** The forwarding user's display name. */
    name?: string;
    /** The forwarding user's DID (used for the profile link). */
    did?: string;
    /** The forwarding user's avatar URL (blob or resolved). */
    avatar?: string;
    /** When the message was forwarded. */
    timestamp: Date;
  } = $props();

  // Bridged (Discord) forwards have no navigable profile; render name as text.
  const isBridged = $derived(did?.startsWith("did:discord:") ?? false);
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
  {#if did && !isBridged}
    <a
      href={`/user/${did}`}
      class="font-medium text-accent-700 dark:text-accent-400 hover:underline truncate"
    >
      {name || did.slice(0, 12)}
    </a>
  {:else}
    <span class="font-medium text-accent-700 dark:text-accent-400 truncate">
      {name || did?.slice(0, 12)}
    </span>
  {/if}
  <span class="shrink-0">forwarded</span>
  <time class="shrink-0 text-[13px] opacity-70">{formatMessageTimestamp(timestamp)}</time>
</div>
