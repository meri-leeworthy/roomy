<script lang="ts">
  import { Modal } from "@foxui/core";
  import Input from "../ui/input/Input.svelte";
  import Button from "../ui/button/Button.svelte";
  import { IconHashtag, IconLoading, IconCheck } from "../../icons/index";
  import ErrorMessage from "../helper/ErrorMessage.svelte";

  export interface ForwardTarget {
    id: string;
    name?: string;
  }

  export type ForwardFetchState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; data: ForwardTarget[] };

  let {
    open = $bindable(false),
    fetchState,
    onForward,
  }: {
    open: boolean;
    fetchState: ForwardFetchState;
    onForward: (roomIds: string[], body: string) => void | Promise<void>;
  } = $props();

  let query = $state("");
  let body = $state("");
  let selected = $state<string[]>([]);
  let forwarding = $state(false);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    if (!open) {
      query = "";
      body = "";
      selected = [];
      forwarding = false;
      errorMessage = null;
    }
  });

  const results = $derived.by<ForwardTarget[]>(() => {
    if (fetchState.status !== "success") return [];
    const q = query.trim().toLowerCase();
    if (!q) return fetchState.data;
    return fetchState.data.filter(
      (t) => t.name?.toLowerCase().includes(q) ?? false,
    );
  });

  const selectedIds = $derived(new Set(selected));

  function toggle(target: ForwardTarget) {
    if (forwarding) return;
    selected = selectedIds.has(target.id)
      ? selected.filter((id) => id !== target.id)
      : [...selected, target.id];
  }

  async function handleSend() {
    if (forwarding || selected.length === 0) return;
    forwarding = true;
    errorMessage = null;
    try {
      await onForward(selected, body);
      open = false;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : "Failed to forward message";
      forwarding = false;
    }
  }
</script>

<Modal bind:open>
  <div class="flex flex-col gap-4">
    <div>
      <h3 class="text-base font-semibold text-base-900 dark:text-base-100">
        Forward message
      </h3>
      <p class="text-sm text-base-500 dark:text-base-400">
        Select one or more rooms, then send.
      </p>
    </div>

    <div>
      <label
        for="forward-body"
        class="text-xs font-semibold uppercase tracking-wide text-base-500 dark:text-base-400"
      >
        Add a message (optional)
      </label>
      <textarea
        id="forward-body"
        bind:value={body}
        rows={3}
        placeholder="Say something with the forwarded message…"
        class="mt-1 w-full resize-y rounded-md text-sm border-1 font-light focus-visible:outline-0 focus:shadow-input focus:bg-accent-50 dark:focus:border-accent-400 border-neutral-400/50 dark:border-neutral-700 bg-neutral-300/50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-100 placeholder:text-base-500 dark:placeholder:text-base-50/50 px-3.5 py-2"
      ></textarea>
    </div>

    <Input
      bind:value={query}
      placeholder="Search rooms…"
      aria-label="Search rooms"
    />

    {#if errorMessage}
      <ErrorMessage message={errorMessage} />
    {/if}

    {#if fetchState.status === "loading"}
      <div class="flex items-center justify-center gap-2 py-6 text-base-400">
        <IconLoading class="size-4 animate-spin" />
        <span class="text-sm">Loading rooms…</span>
      </div>
    {:else if fetchState.status === "error"}
      <ErrorMessage message={fetchState.message} class="py-4 justify-center text-center" />
    {:else if fetchState.status === "success"}
      {#if results.length === 0}
        <p class="text-sm text-base-400 dark:text-base-500 py-4 text-center">
          No matching rooms.
        </p>
      {:else}
        <ul class="flex flex-col gap-1 max-h-[40vh] overflow-y-auto">
          {#each results as target (target.id)}
            {@const isSelected = selectedIds.has(target.id)}
            <li>
              <button
                type="button"
                onclick={() => toggle(target)}
                disabled={forwarding}
                aria-pressed={isSelected}
                class={
                  "w-full flex items-center gap-2 rounded-md py-2 px-2 text-start font-normal border-1 disabled:opacity-50 " +
                  (isSelected
                    ? "border-accent-500/60 bg-accent-50 dark:bg-accent-900/40"
                    : "border-transparent hover:bg-base-100 dark:hover:bg-base-400/10")
                }
              >
                <IconHashtag class="size-4 shrink-0 text-base-400" />
                <span class="truncate text-sm text-base-800 dark:text-base-200 flex-1">
                  {target.name ?? "Unnamed room"}
                </span>
                {#if isSelected}
                  <IconCheck class="size-4 shrink-0 text-accent-600 dark:text-accent-400" />
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button
        variant="primary"
        onclick={handleSend}
        disabled={selected.length === 0 || forwarding}
      >
        {#if forwarding}
          <IconLoading class="size-4 animate-spin" />
          Sending…
        {:else}
          Send {selected.length > 0 ? `to ${selected.length} room${selected.length > 1 ? "s" : ""}` : ""}
        {/if}
      </Button>
    </div>
  </div>
</Modal>
