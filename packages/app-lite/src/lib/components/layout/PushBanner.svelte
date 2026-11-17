<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { toast } from "@foxui/core";
  import { IconAlertCircle, IconBell, IconX } from "@roomy/design/icons";
  import {
    ensurePushSubscription,
    getPushSubscriptionEndpoint,
    pushOutcomeMessage,
  } from "$lib/push.svelte";
  import { notePushAttempt, pushNotice } from "$lib/push-notice.svelte";

  const DISMISS_KEY = "roomy.push.bannerDismissed";

  let pushEnabled: boolean | null = $state(null);
  let dismissed = $state(false);
  let retrying = $state(false);

  /**
   * A login-time re-subscribe that left this device without notifications.
   * It outranks the "enable" prompt below: that user already granted
   * permission and believes notifications are on.
   */
  const failure = $derived(pushNotice.failure);

  // The settings page's push row carries the same state, so neither variant
  // follows the user there.
  const onSettingsPage = $derived(
    page.url.pathname.startsWith("/user/settings/notifications"),
  );

  $effect(() => {
    // Re-check on every navigation (page URL change) so enabling notifications
    // on the settings page suppresses the banner immediately on return.
    page.url;
    dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    getPushSubscriptionEndpoint().then((endpoint) => {
      pushEnabled = endpoint !== null;
    });
  });

  let visible = $derived(
    failure === null && pushEnabled === false && !dismissed && !onSettingsPage,
  );

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    dismissed = true;
  }

  function navigate() {
    goto("/user/settings/notifications");
  }

  /**
   * Re-subscribe from an explicit click — `Notification.requestPermission()`
   * only works inside a user gesture, so this cannot be retried automatically.
   * The result replaces the notice (the toast reports it too, since the click
   * was the user's and they are looking at the outcome).
   */
  async function retry() {
    retrying = true;
    try {
      const outcome = await ensurePushSubscription();
      notePushAttempt(outcome);
      if (outcome.status === "ok") {
        localStorage.setItem(DISMISS_KEY, "1");
        toast.success("Notifications enabled");
      } else {
        toast.error(pushOutcomeMessage(outcome));
      }
    } catch (e) {
      toast.error(
        `Couldn't enable notifications: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      retrying = false;
    }
  }
</script>

{#if failure !== null && !onSettingsPage}
  <div
    class="flex items-center gap-2 pl-4 pr-1 py-0.5 text-xs bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    role="status"
    aria-live="polite"
  >
    <IconAlertCircle class="size-4 shrink-0" />
    <span class="min-w-0">
      <span class="text-amber-800 dark:text-amber-300"
        >Notifications are off on this device.</span
      >
      <span class="text-amber-700/80 dark:text-amber-400/80"
        >{pushOutcomeMessage(failure)}</span
      >
    </span>
    <button
      type="button"
      class="ml-auto shrink-0 px-2 py-0.5 font-semibold text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200 transition-colors disabled:opacity-60"
      onclick={retry}
      disabled={retrying}
    >
      {retrying ? "Retrying…" : "Retry"}
    </button>
    <button
      type="button"
      class="p-1 shrink-0 text-amber-600 hover:text-amber-800 dark:text-amber-500 dark:hover:text-amber-300 transition-colors"
      aria-label="Dismiss"
      onclick={() => pushNotice.dismiss()}
    >
      <IconX class="size-4" />
    </button>
  </div>
{:else if visible}
  <div
    class="flex items-center gap-2 pl-4 pr-2 py-0.5 text-xs bg-base-100 dark:bg-base-900 cursor-pointer select-none hover:bg-base-200/50 dark:hover:bg-base-800/40 transition-colors"
    role="banner"
    onclick={navigate}
    onkeydown={(e) => e.key === "Enter" && navigate()}
    tabindex="0"
  >
    <IconBell class="size-4 shrink-0 text-base-500" />
    <span class="min-w-0">
      <span class="text-base-700 dark:text-base-300">Get notified when someone messages you.</span>
      <span class="font-semibold text-accent-600 dark:text-accent-400">Enable notifications</span>
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
