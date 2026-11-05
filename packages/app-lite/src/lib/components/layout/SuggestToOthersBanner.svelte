<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { IconGlobe, IconX } from "@roomy/design/icons";
  import { auth } from "$lib/auth.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";

  /**
   * Asks an admin of a space whether it may be suggested to people who are not
   * members. `getSpaces` reports `suggestToOthers` as null while no admin has
   * answered, so the question is answerable per space and nothing is stored
   * server-side to prompt it — this banner is the prompt.
   *
   * Dismissal is per user (`<prefix>.<did>`), not per space: each admin answers
   * for themselves, and dismissing hides the notice for that reader only. It
   * also disappears once an admin answers, because the saved setting makes
   * `suggestToOthers` a boolean.
   */
  const DISMISS_KEY_PREFIX = "roomy.suggestToOthers.promptDismissed";

  // Shares the sidebar's query key (`includeLeft: true`), so reading the list
  // here costs no extra request.
  const spacesQuery = createSpacesQuery({ includeLeft: true });

  let dismissed = $state(false);

  $effect(() => {
    page.url;
    const did = auth.userDid;
    dismissed =
      did !== null &&
      localStorage.getItem(`${DISMISS_KEY_PREFIX}.${did}`) === "1";
  });

  // Absent `suggestToOthers` means the space has no setting to answer (no
  // `comp_space` row), so it is not this banner's business.
  const space = $derived(
    (spacesQuery.data?.spaces ?? []).find(
      (s) => s.isAdmin && s.suggestToOthers === null,
    ),
  );

  // The banner points at the settings page; once the reader is there, it has
  // nothing left to say.
  const onSettingsPage = $derived(
    space !== undefined && page.url.pathname === `/${space.id}/settings`,
  );

  const visible = $derived(
    space !== undefined && !dismissed && !onSettingsPage,
  );

  function dismiss() {
    const did = auth.userDid;
    if (did !== null) {
      localStorage.setItem(`${DISMISS_KEY_PREFIX}.${did}`, "1");
    }
    dismissed = true;
  }

  function navigate() {
    if (space !== undefined) goto(`/${space.id}/settings`);
  }
</script>

{#if visible && space}
  <div
    class="flex items-center gap-2 pl-4 pr-2 py-0.5 text-xs bg-base-100 dark:bg-base-900 cursor-pointer select-none hover:bg-base-200/50 dark:hover:bg-base-800/40 transition-colors"
    role="banner"
    onclick={navigate}
    onkeydown={(e) => e.key === "Enter" && navigate()}
    tabindex="0"
  >
    <IconGlobe class="size-4 shrink-0 text-base-500" />
    <span class="min-w-0">
      <span class="text-base-700 dark:text-base-300"
        >Should {space.name ?? "this space"} be suggested to other people?</span
      >
      <span class="font-semibold text-accent-600 dark:text-accent-400"
        >Choose</span
      >
    </span>
    <button
      type="button"
      class="p-1 -mr-1 ml-auto text-base-400 hover:text-base-600 dark:hover:text-base-300 transition-colors"
      aria-label="Dismiss"
      onclick={(e) => {
        e.stopPropagation();
        dismiss();
      }}
    >
      <IconX class="size-4" />
    </button>
  </div>
{/if}
