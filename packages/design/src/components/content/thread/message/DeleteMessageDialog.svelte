<script lang="ts">
  import { Modal } from "@foxui/core";
  import Button from "../../../ui/button/Button.svelte";
  import { IconTrash } from "../../../../icons/index";

  let {
    open = $bindable(false),
    authorName,
    isAdminDelete = false,
    count = 1,
    otherAuthors = [],
    onConfirm,
  }: {
    open: boolean;
    /** Display name of the message author — shown in the confirm body.
     *  Single-message only; a multi-message delete names the count instead. */
    authorName?: string;
    /** True when the caller is a space admin deleting someone else's message. */
    isAdminDelete?: boolean;
    /** Number of messages being deleted. 1 = the single-message copy. */
    count?: number;
    /** Display names of the *other* authors whose messages the selection
     *  includes (i.e. not the caller's own). Non-empty ⇒ the moderation
     *  warning, since deleting someone else's message is the admin case. */
    otherAuthors?: string[];
    onConfirm: () => void | Promise<void>;
  } = $props();

  let deleting = $state(false);

  const many = $derived(count > 1);

  /** Named authors, capped so a large selection doesn't render a wall of
   *  names; the tail collapses to a count. */
  const otherAuthorList = $derived.by(() => {
    const names = otherAuthors;
    if (names.length === 0) return "";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  });

  async function confirm() {
    if (deleting) return;
    deleting = true;
    try {
      await onConfirm();
    } finally {
      deleting = false;
      open = false;
    }
  }
</script>

<Modal bind:open closeButton={true} class="gap-6">
  <div class="flex flex-col gap-2">
    <h1
      id="dialog-title"
      class="text-base font-bold text-xl text-base-900 dark:text-base-100"
    >
      {many ? "Delete messages" : "Delete message"}
    </h1>
    <p class="text-base-800 dark:text-base-300 text-sm">
      {#if many}
        Are you sure you want to delete
        <b>{count} messages</b>? This cannot be undone.
      {:else if isAdminDelete}
        Are you sure you want to delete
        {#if authorName}
          <b>{authorName}</b>'s
        {:else}
          this user's
        {/if}
        message? This cannot be undone.
      {:else}
        Are you sure you want to delete this message? This cannot be undone.
      {/if}
    </p>
    {#if many && otherAuthorList}
      <p class="text-red-700 dark:text-red-400 text-sm">
        This selection includes messages from {otherAuthorList}.
      </p>
    {/if}
  </div>
  <div class="flex flex-row w-full justify-end gap-2">
    <Button onclick={() => (open = false)} variant="secondary">
      Cancel
    </Button>
    <Button onclick={confirm} variant="red" disabled={deleting}>
      <IconTrash class="size-4" />
      {deleting ? "Deleting…" : many ? "Delete Messages" : "Delete Message"}
    </Button>
  </div>
</Modal>
