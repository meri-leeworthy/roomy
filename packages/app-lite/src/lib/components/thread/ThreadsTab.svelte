<script lang="ts">
  import { page } from "$app/state";
  import { createSpaceThreadsQuery } from "$lib/queries/threads";
  import BoardViewShell from "@roomy/design/components/content/thread/boardView/BoardView.svelte";
  import type { ThreadInfo } from "@roomy/design/components/content/thread/boardView/types.ts";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { IconSearch } from "@roomy/design/icons";
  import { resolveBlobUrl } from "$lib/utils";

  let { spaceId }: { spaceId: string } = $props();

  // Debounced search input: filters threads by name server-side (SQLite LIKE
  // on the thread name). 200ms matches the mention typeahead debounce.
  let searchInput = $state("");
  let searchTerm = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchTerm = searchInput.trim();
    }, 200);
  });

  const threadsQuery = createSpaceThreadsQuery(() => spaceId, () => searchTerm);

  // Flatten all pages into a single array.
  let threads = $derived<ThreadInfo[]>(
    (threadsQuery.data?.pages.flatMap((p) => p.threads) ?? []).map(mapThread),
  );

  let hasMore = $derived(threadsQuery.hasNextPage ?? false);

  function loadMore() {
    threadsQuery.fetchNextPage();
  }

  function mapThread(t: {
    id: string;
    name?: string;
    channelName?: string;
    canonicalParent?: string;
    unreadCount?: number;
    unread?: boolean;
    activity: {
      latestTimestamp?: string;
      latestMembers: Array<{ did: string; name?: string | null; avatar?: string | null }>;
    };
  }): ThreadInfo {
    return {
      id: t.id,
      name: t.name ?? "Unnamed Thread",
      kind: "space.roomy.thread",
      channelName: t.channelName,
      canonicalParent: t.canonicalParent,
      // Honest unread: the server marks threads with messages the user
      // hasn't read, including threads they've never engaged with.
      unread: t.unread ?? (t.unreadCount ?? 0) > 0,
      activity: {
        members: t.activity.latestMembers.map((m) => ({
          id: m.did,
          name: m.name ?? null,
          avatar: resolveBlobUrl(m.avatar ?? undefined) ?? null,
        })),
        latestTimestamp: t.activity.latestTimestamp
          ? new Date(t.activity.latestTimestamp).getTime()
          : 0,
      },
    };
  }

  function hrefFor(thread: ThreadInfo): string {
    const parentParam = thread.canonicalParent
      ? "?parent=" + thread.canonicalParent
      : "";
    return `/${page.params.space}/${thread.id}${parentParam}`;
  }
</script>

{#if threadsQuery.isPending && !threadsQuery.data}
  <div class="h-full w-full flex items-center justify-center">
    <div class="text-sm text-base-400 p-2">Loading threads…</div>
  </div>
{:else if threadsQuery.isError && !threadsQuery.data}
  <ErrorMessage message={threadsQuery.error.message} class="h-full w-full justify-center" />
{:else}
  <div class="flex flex-col h-full min-h-0">
    <div class="relative shrink-0 px-3 pt-2">
      <IconSearch class="absolute left-6 top-1/2 -translate-y-1/2 size-4 text-base-400" />
      <input
        type="text"
        bind:value={searchInput}
        placeholder="Search threads…"
        class="w-full ring-1 ring-inset ring-base-300 dark:ring-base-700 focus:ring-2 focus:ring-accent-500 bg-base-100 dark:bg-base-800/50 focus:bg-accent-400/5 dark:focus:bg-accent-600/5 text-base-900 dark:text-base-100 placeholder:text-base-400 dark:placeholder:text-base-500 rounded-2xl pl-9 pr-3 py-1.5 text-sm font-medium outline-none border-0 transition-colors"
      />
    </div>
    <div class="flex-1 min-h-0">
      <BoardViewShell {threads} emptyMessage={searchTerm ? "No matching threads" : "No threads yet"} {hrefFor} {loadMore} {hasMore} />
    </div>
  </div>
{/if}
