<script lang="ts">
  import { page } from "$app/state";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ErrorMessage from "@roomy/design/components/helper/ErrorMessage.svelte";
  import { IconCheck, IconAlertCircle } from "@roomy/design/icons";
  import { createMembershipStatusQuery } from "$lib/queries/membership-status";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";

  // Polar checkout URL for Roomy Pro (billed via polar.sh).
  const CHECKOUT_URL = "https://buy.polar.sh/polar_cl_lsCqRe7pBprn4yTCjKcdJ8ShjMQGnEXPoUPoG3xUIPl";

  // The pro-subscription flag gates this page (direct navigation lands
  // here even when the sidebar tab is hidden).
  const flagsQuery = createFeatureFlagsQuery();
  const proEnabled = $derived(
    flagsQuery.data?.flags.includes("pro-subscription") ?? false,
  );

  // After a successful checkout Polar redirects back to this page with
  // ?checkout={CHECKOUT_ID}. Passing it to the status query forces a
  // non-cached Polar refresh so the new membership shows immediately.
  // Read once at mount: the param is fixed by the redirect and never
  // changes while this page is mounted.
  const checkoutId = $state(page.url.searchParams.get("checkout") ?? undefined);
  const statusQuery = createMembershipStatusQuery(() => checkoutId);

  const status = $derived(statusQuery.data);
  const error = $derived(
    statusQuery.error
      ? statusQuery.error instanceof Error
        ? statusQuery.error.message
        : String(statusQuery.error)
      : null,
  );
</script>

<div class="flex flex-col gap-10">
  {#if !proEnabled}
    <div class="flex flex-col items-center gap-4 py-12">
      <p class="text-sm text-base-500 dark:text-base-400">
        Roomy Pro is not enabled for your account yet.
      </p>
    </div>
  {:else}
  <!-- Status section -->
  <section>
    <h2 class="text-base font-semibold mb-4 text-base-900 dark:text-base-100">
      Roomy Pro
    </h2>

    {#if checkoutId}
      <div
        class="flex items-start gap-2 rounded-lg border border-green-600/30 bg-green-50 dark:bg-green-950/30 px-3 py-2.5 mb-4"
      >
        <IconCheck class="size-4 shrink-0 mt-0.5 text-green-700 dark:text-green-400" />
        <p class="text-sm text-green-800 dark:text-green-300">
          Checkout complete — confirming your subscription…
        </p>
      </div>
    {/if}

    {#if statusQuery.isPending}
      <p class="text-sm text-base-400">Checking your subscription…</p>
    {:else if error}
      <ErrorMessage message="Error: {error}" class="py-4" />
    {:else if status}
      {#if status.isPro}
        <div
          class="flex items-start gap-2 rounded-lg border border-green-600/30 bg-green-50 dark:bg-green-950/30 px-3 py-2.5"
        >
          <IconCheck class="size-4 shrink-0 mt-0.5 text-green-700 dark:text-green-400" />
          <div class="flex flex-col gap-0.5">
            <p class="text-sm font-medium text-green-800 dark:text-green-300">
              You're a Roomy Pro member
            </p>
            <p class="text-sm text-green-700/80 dark:text-green-400/80">
              Bridge capacity: {status.capacity} members
              {status.stale ? " (status may be stale — Polar is unreachable right now)" : ""}
            </p>
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-3">
          <p class="text-sm text-base-400">
            Roomy Pro unlocks bridge tokens: connect a Discord guild to your
            space and bridge up to 1000 members.
          </p>
          <div>
            <Button href={CHECKOUT_URL} variant="cta">
              Subscribe to Roomy Pro
            </Button>
          </div>
          {#if status.stale}
            <p class="text-sm text-base-400 flex items-center gap-1.5">
              <IconAlertCircle class="size-4 shrink-0 text-base-400" />
              We couldn't reach the billing provider just now — showing the
              last known status. Try again in a moment.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
  </section>
  {/if}
</div>
