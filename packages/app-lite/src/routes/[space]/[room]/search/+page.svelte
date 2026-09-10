<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setNavbar, setSpaceInfo } from "$lib/components/layout/navbar.svelte";
  import { currentSpaceState } from "$lib/components/layout/current-space.svelte";
  import { searchTerm } from "$lib/components/layout/search-term.svelte";
  import SearchResultsList from "$lib/components/search/SearchResultsList.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import { createRoomMetadataQuery } from "$lib/queries/room-metadata";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import type { SearchMessage } from "$lib/queries/search";
  import { resolveBlobUrl } from "$lib/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  // Search feature flag: gates the page — a room is searchable only when
  // the `search` flag is enabled for the user, matching the navbar entry
  // point and the other search pages.
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  const roomId = $derived(page.params.room!);
  const spaceId = $derived(page.params.space!);
  const query = $derived(page.url.searchParams.get("q") ?? "");
  const currentSpace = $derived(currentSpaceState.value);

  const roomMetaQuery = createRoomMetadataQuery(() => roomId);
  // Display name for the room being searched (from the dedicated metadata
  // query — the room page's sidebar-derived name lives in its own page).
  const roomName = $derived(
    roomMetaQuery.data?.name ?? (roomMetaQuery.isSuccess ? "room" : "…"),
  );
  // `space.roomy.room.getMetadata` reports the kind (`channel`/`thread`):
  // a thread-scoped search is the thread alone — no rooms-and-threads
  // name section (the parent channel isn't in scope either).
  const isThread = $derived(roomMetaQuery.data?.kind === "thread");

  // The parent channel of a thread-scoped search, for the widen-search
  // link. Resolved from the space sidebar (`space.getMetadata`, already
  // cached by the [space] layout — no extra fetch); an inactive thread
  // may be missing from the sidebar, so the label then falls back to
  // the space name and the link to the space search.
  const spaceMetaQuery = createSpaceMetadataQuery(() => spaceId);
  const parentChannel = $derived.by<{ id: string; name?: string } | undefined>(() => {
    const meta = spaceMetaQuery.data;
    if (!meta || !isThread) return undefined;
    const find = (channels: typeof meta.sidebar.orphans) => {
      for (const ch of channels) {
        if (ch.activeThreads?.some((t) => t.id === roomId)) {
          return { id: ch.id, name: ch.name };
        }
      }
      return undefined;
    };
    for (const cat of meta.sidebar.categories) {
      const found = find(cat.channels);
      if (found) return found;
    }
    return find(meta.sidebar.orphans);
  });

  // Widen-the-search link for the bottom of the results. A channel search
  // widens to the space; a thread search widens to its parent channel
  // (which also covers the thread itself).
  const widenScope = $derived(
    roomMetaQuery.data?.kind === "channel"
      ? {
          label: `Search in ${currentSpace?.name ?? "this space"}`,
          href: `/${spaceId}/search`,
        }
      : isThread
        ? {
            label: `Search in ${parentChannel?.name ?? currentSpace?.name ?? "this space"}`,
            href: parentChannel
              ? `/${spaceId}/${parentChannel.id}/search`
              : `/${spaceId}/search`,
          }
        : null,
  );

  // The navbar searchbar owns the input on this page; the page title
  // ("Search in <room>") becomes its placeholder. Re-seed the shared term
  // from the URL `?q=` so back/forward and deep links keep working — but
  // only when the URL query actually changes, so a late-loading room name
  // never clobbers the user's in-progress typing.
  let lastSyncedQuery = $state<string | null>(null);
  $effect(() => {
    if (query === lastSyncedQuery) return;
    lastSyncedQuery = query;
    searchTerm.input = query;
  });
  $effect(() => {
    searchTerm.placeholder = `Search in ${roomName}`;
  });

  onMount(() => {
    setNavbar(undefined);
    setSpaceInfo(searchSpaceInfo);
    return () => {
      setNavbar(undefined);
      setSpaceInfo(undefined);
    };
  });
</script>

<SeoMeta
  title={`Search in ${roomName} - ${currentSpace?.name ?? "Space"} - Roomy`}
  description={`Search messages in ${roomName}`}
/>

{#snippet searchSpaceInfo()}
  <div class="flex items-center gap-2 ml-4 sm:ml-2 min-w-0">
    <!-- Space context (avatar): mobile-only, mirroring NavbarSpaceInfo. -->
    {#if currentSpace}
      <span class="sm:hidden shrink-0">
        <SpaceAvatar
          src={resolveBlobUrl(currentSpace.avatar)}
          id={currentSpace.id}
          name={currentSpace.name ?? undefined}
          size={24}
        />
      </span>
    {/if}
    <span class="text-base-300 dark:text-base-700 shrink-0 sm:hidden">/</span>
    <span class="shrink-0 sm:hidden text-base-400">#</span>
  </div>
{/snippet}

<div class="h-full dark:bg-base-900/20 text-base-800 dark:text-base-200">
  {#if !searchEnabled}
    <div class="h-full flex items-center justify-center">
      <p class="text-sm text-base-500 dark:text-base-400">
        Search is not enabled for your account yet.
      </p>
    </div>
  {:else}
    <SearchResultsList
      {query}
      {spaceId}
      {roomId}
      scopeLabel={`"${roomName}"`}
      disableRoomsSearch={isThread}
      expandScope={widenScope}
      hrefFor={(m: SearchMessage) => `/${m.spaceId}/${m.roomId}?message=${m.id}`}
    />
  {/if}
</div>
