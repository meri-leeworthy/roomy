<script lang="ts">
  import { onMount } from "svelte";
  import { currentSpaceState } from "./current-space.svelte";
  import { currentRoomState, setCurrentRoom } from "./current-room.svelte";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import { IconEllipsisHorizontal, IconHashtag, IconHome, IconNeedleThread, IconChevronRight } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { editRoomModal } from "$lib/components/sidebar/edit-room.svelte";

  const currentSpace = $derived(currentSpaceState.value);
  const currentRoom = $derived(currentRoomState.value);

  // Same admin source the sidebar's edit affordances use (getMetadata
  // isAdmin), so the two entry points can never disagree about who may edit.
  // The query is already cached by the space layout; this is a cache read.
  const metaQuery = createSpaceMetadataQuery(() => currentSpace?.id ?? "", {
    enabled: () => !!currentSpace?.id,
  });
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);

  onMount(() => {
    return () => setCurrentRoom(null);
  });
</script>

{#if currentSpace}
  <div class="flex items-center gap-2 ml-4 sm:ml-2 min-w-0">
    <!-- Space context (avatar + name): mobile-only. On desktop the sidebar
         already shows the space header, so it's redundant here. -->
    <a href="/{currentSpace.id}" class="sm:hidden shrink-0">
      <SpaceAvatar
        src={resolveBlobUrl(currentSpace.avatar)}
        id={currentSpace.id}
        name={currentSpace.name ?? undefined}
        size={24}
      />
    </a>
    {#if currentRoom}
      {#if currentRoom.kind === "thread"}
        <!-- Thread breadcrumb: parent channel link + thread name -->
        {#if currentRoom.parentChannelId}
          <!-- Mobile: ellipsis + caret -->
          <a href="/{currentSpace.id}/{currentRoom.parentChannelId}" class="sm:hidden flex items-center gap-1 text-base-500 hover:text-base-700 dark:hover:text-base-300">
            <IconEllipsisHorizontal class="size-4 shrink-0" />
            <IconChevronRight class="size-3 shrink-0" />
          </a>
          <!-- Desktop: hashtag + parent channel name -->
          <a href="/{currentSpace.id}/{currentRoom.parentChannelId}" class="hidden sm:flex items-center gap-1 text-base-500 hover:text-base-700 dark:hover:text-base-300 min-w-0">
            <IconHashtag class="size-4 shrink-0" />
            <span class="text-sm truncate">{currentRoom.parentChannelName}</span>
            <IconChevronRight class="size-3 shrink-0" />
          </a>
        {/if}
        <IconNeedleThread class="size-4 shrink-0 text-base-500" />
      {:else if currentRoom.federatedOrigin}
        <!-- Federated channel: origin space avatar + name, then the channel -->
        <span class="shrink-0" title={currentRoom.federatedOrigin.name ?? currentRoom.federatedOrigin.id}>
          <SpaceAvatar
            src={resolveBlobUrl(currentRoom.federatedOrigin.avatar)}
            id={currentRoom.federatedOrigin.id}
            name={currentRoom.federatedOrigin.name ?? undefined}
            size={16}
          />
        </span>
        <span class="text-sm font-medium text-base-500 dark:text-base-400 truncate">
          {currentRoom.federatedOrigin.name ?? currentRoom.federatedOrigin.id}
        </span>
        <IconChevronRight class="size-3 shrink-0 text-base-500" />
        <IconHashtag class="size-4 shrink-0 text-base-500" />
      {:else}
        <IconHashtag class="size-4 shrink-0 text-base-500" />
      {/if}
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        {currentRoom.name}
      </span>
      {#if isAdmin}
        <button
          type="button"
          onclick={() => editRoomModal.openFor({ room: currentRoom.id })}
          class="shrink-0 rounded-full p-1 text-base-400 dark:text-base-500 hover:bg-base-200/50 hover:text-base-700 dark:hover:bg-base-900/30 dark:hover:text-base-200 cursor-pointer"
          aria-label="Room settings"
          title="Room settings"
        >
          <IconEllipsisHorizontal class="size-4" />
        </button>
      {/if}
    {:else}
      <IconHome class="size-4 shrink-0 text-base-500 ml-0.5 -mt-0.5" />
      <span
        class="text-sm font-medium text-base-700 dark:text-base-300 truncate"
      >
        Index
      </span>
    {/if}
  </div>
{/if}