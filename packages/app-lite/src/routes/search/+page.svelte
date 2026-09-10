<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import { searchTerm } from "$lib/components/layout/search-term.svelte";
  import SpaceSidebar from "$lib/components/sidebar/SpaceSidebar.svelte";
  import SearchResultsList from "$lib/components/search/SearchResultsList.svelte";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import type { SearchMessage } from "$lib/queries/search";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  // Search feature flag: gates the page (direct navigation lands here even
  // when the flag is off, showing the disabled state).
  const flagsQuery = createFeatureFlagsQuery();
  const searchEnabled = $derived(
    flagsQuery.data?.flags.includes("search") ?? false,
  );

  // The query string is the URL source of truth (the navbar search submit
  // navigates here); changing it re-seeds the results list.
  const query = $derived(page.url.searchParams.get("q") ?? "");

  // The navbar searchbar owns the input on this page; the page title
  // ("Search") becomes its placeholder. Re-seed the shared term from the
  // URL `?q=` so back/forward and deep links keep working — but only when
  // the URL query actually changes, so navigation never clobbers the
  // user's in-progress typing.
  let lastSyncedQuery = $state<string | null>(null);
  $effect(() => {
    if (query === lastSyncedQuery) return;
    lastSyncedQuery = query;
    searchTerm.input = query;
  });
  $effect(() => {
    searchTerm.placeholder = "Search";
  });

  onMount(() => {
    setNavbar(undefined);
    setSidebarContent(homeSidebar);
    setWideSidebar(true);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
      setWideSidebar(false);
    };
  });
</script>

<SeoMeta title="Search - Roomy" description="Search messages across all your spaces" />

{#snippet homeSidebar()}
  <SpaceSidebar />
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
      scopeLabel="all your spaces"
      showSpaceInfo
      hrefFor={(m: SearchMessage) => `/${m.spaceId}/${m.roomId}?message=${m.id}`}
    />
  {/if}
</div>
