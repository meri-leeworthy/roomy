<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setNavbar, setSpaceInfo } from "$lib/components/layout/navbar.svelte";
  import { currentSpaceState } from "$lib/components/layout/current-space.svelte";
  import { searchTerm } from "$lib/components/layout/search-term.svelte";
  import SearchResultsList from "$lib/components/search/SearchResultsList.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import type { SearchMessage } from "$lib/queries/search";
  import { resolveBlobUrl } from "$lib/utils";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  // Search feature flag: gates the page — a space is searchable only when
  // the `search` flag is enabled for the user, matching the navbar entry
  // point and the directory search page.
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  const spaceId = $derived(page.params.space!);
  const query = $derived(page.url.searchParams.get("q") ?? "");
  const currentSpace = $derived(currentSpaceState.value);

  // The navbar searchbar owns the input on this page; the page title
  // ("Search <space>") becomes its placeholder. Re-seed the shared term
  // from the URL `?q=` so back/forward and deep links keep working — but
  // only when the URL query actually changes, so a late-loading space name
  // never clobbers the user's in-progress typing.
  let lastSyncedQuery = $state<string | null>(null);
  $effect(() => {
    if (query === lastSyncedQuery) return;
    lastSyncedQuery = query;
    searchTerm.input = query;
  });
  $effect(() => {
    searchTerm.placeholder = `Search ${currentSpace?.name ?? "this space"}`;
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
  title={`Search - ${currentSpace?.name ?? "Space"} - Roomy`}
  description={`Search messages in ${currentSpace?.name ?? "this space"}`}
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
      scopeLabel={`"${currentSpace?.name ?? "this space"}"`}
      expandScope={{ label: "Search in all your spaces", href: "/search" }}
      hrefFor={(m: SearchMessage) => `/${m.spaceId}/${m.roomId}?message=${m.id}`}
    />
  {/if}
</div>
