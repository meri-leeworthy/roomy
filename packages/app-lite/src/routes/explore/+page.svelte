<script lang="ts">
  import { onMount } from "svelte";
  import { createQueries } from "@tanstack/svelte-query";
  import { cache } from "@roomy-space/sdk";
  import { px } from "$lib/auth.svelte";
  import { queryClient } from "$lib/client";
  import { setNavbar } from "$lib/components/layout/navbar.svelte";
  import { setSidebarContent } from "$lib/components/layout/sidebar.svelte";
  import { setWideSidebar } from "$lib/components/layout/wide-sidebar.svelte";
  import { createSearchMessagesQuery, type SearchMessage } from "$lib/queries/search";
  import { resolveBlobUrl } from "$lib/utils";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import UserAvatar from "@roomy/design/components/user/UserAvatar.svelte";
  import { IconSearch } from "@roomy/design/icons";
  import MessageContent from "$lib/components/chat/MessageContent.svelte";
  import SeoMeta from "$lib/components/seo/SeoMeta.svelte";

  const { queryKey } = cache;

  let searchInput = $state("");
  let searchTerm = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchTerm = searchInput.trim();
    }, 250);
  });

  const searchQuery = createSearchMessagesQuery(() => searchTerm);

  // Space names for result context: one lightweight getSpaceSummary query
  // per distinct space in the results. createQueries is reactive — the
  // accessor re-runs as results change, and the results array updates as
  // each summary lands (getQueryData reads would be non-reactive).
  const spaceIds = $derived(
    [...new Set((searchQuery.data?.messages ?? []).map((m) => m.spaceId).filter(Boolean))] as string[],
  );

  const spaceSummaryQueries = createQueries(
    () => ({
      queries: spaceIds.map((sid) => ({
        queryKey: queryKey("space.roomy.space.getSpaceSummary", { spaceId: sid }),
        queryFn: () => px().query("space.roomy.space.getSpaceSummary", { spaceId: sid }),
      })),
    }),
    () => queryClient,
  );

  const spaceNames = $derived.by<Map<string, { name?: string; avatar?: string }>>(() => {
    const map = new Map<string, { name?: string; avatar?: string }>();
    for (let i = 0; i < spaceIds.length; i++) {
      const data = spaceSummaryQueries[i]?.data;
      if (data) map.set(spaceIds[i]!, data);
    }
    return map;
  });

  onMount(() => {
    setNavbar(exploreNavbar);
    setSidebarContent(undefined);
    setWideSidebar(true);
    return () => {
      setNavbar(undefined);
      setSidebarContent(undefined);
      setWideSidebar(false);
    };
  });

  function hrefFor(m: SearchMessage): string {
    return `/${m.spaceId}/${m.roomId}`;
  }
</script>

<SeoMeta title="Explore - Roomy" description="Search across all your spaces" />

{#snippet exploreNavbar()}
  <div class="flex w-full items-center gap-2 px-2 min-w-0 grow">
    <span class="text-sm font-semibold truncate">Explore</span>
  </div>
{/snippet}

<div class="h-full dark:bg-base-900/20 text-base-800 dark:text-base-200">
  <main class="h-full overflow-y-auto text-base-950 dark:text-base-50">
    <div class="flex flex-col items-center py-8 px-4">
      <div class="w-full max-w-2xl flex flex-col gap-4">
        <div class="relative">
          <IconSearch class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-base-400" />
          <input
            type="text"
            bind:value={searchInput}
            placeholder="Search messages across all your spaces…"
            class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl pl-9 pr-3 py-2 text-sm font-medium outline-none border-0 transition-colors"
          />
        </div>

        {#if searchTerm.length === 0}
          <p class="text-sm text-base-400">Search across all your spaces. Results link to the room the message lives in.</p>
        {:else if searchTerm.length < 3}
          <p class="text-sm text-base-400">Type at least 3 characters to search.</p>
        {:else if searchQuery.isPending}
          <p class="text-sm text-base-400">Searching…</p>
        {:else if searchQuery.isError}
          <ErrorMessage message={searchQuery.error.message} class="py-8" />
        {:else if searchQuery.data}
          {#if searchQuery.data.messages.length === 0}
            <p class="text-sm text-base-400">No messages found.</p>
          {:else}
            <ul class="space-y-2">
              {#each searchQuery.data.messages as m (m.id)}
                <li>
                  <a
                    href={hrefFor(m)}
                    class="block p-3 rounded-xl bg-white dark:bg-base-900 border border-base-200 dark:border-base-800 hover:border-accent-400 dark:hover:border-accent-600 transition-colors"
                  >
                    <div class="flex items-center gap-2 mb-1.5">
                      <UserAvatar
                        src={resolveBlobUrl(m.authorAvatar)}
                        name={m.authorDid}
                        size={20}
                        class="size-5 shrink-0 rounded-full"
                      />
                      <span class="text-sm font-medium truncate">{m.authorName ?? m.authorDid}</span>
                      <span class="text-xs text-base-400 truncate ml-auto">
                        {spaceNames.get(m.spaceId ?? "")?.name ?? m.spaceId}
                      </span>
                    </div>
                    <div class="text-sm text-base-700 dark:text-base-300 line-clamp-2">
                      <MessageContent content={m.content} mimeType={m.mimeType} />
                    </div>
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    </div>
  </main>
</div>
