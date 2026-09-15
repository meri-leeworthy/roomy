<script lang="ts">
  import { type Snippet } from "svelte";
  import UserAvatar from "./UserAvatar.svelte";
  import Badge from "../ui/badge/Badge.svelte";
  import { IconGlobe } from "../../icons/index";

  // Props
  let {
    profile,
    actions,
  }: {
    profile: {
      did?: string;
      handle?: string;
      displayName?: string;
      pronouns?: string;
      website?: string;
      avatar?: string;
      banner?: string;
      description?: string;
      accountId?: string;
    };
    actions?: Snippet;
  } = $props();

  // `website` is a free-form uri-format string; it may lack a scheme
  // (e.g. "example.com"), which browsers would otherwise resolve relative to
  // the current origin. Only treat the value as already-qualified when it
  // parses as an absolute http(s) URL, so hostile/odd schemes degrade to a
  // harmless https:// prefix instead of a live link into the page.
  function websiteHref(website: string): string {
    const value = website.trim();
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return value;
    } catch {
      // not absolute — fall through
    }
    return `https://${value}`;
  }

  // Displayed label: host + path without the scheme, so the link reads as
  // "example.com/about" rather than a full URL twice as long as the layout.
  function websiteLabel(website: string): string {
    return websiteHref(website).replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  // Function to convert URLs in text to clickable links
  function linkifyText(text: string): string {
    const urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
    return text
      .replaceAll("\n", "<br/>")
      .replace(
        urlRegex,
        '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-primary hover:text-primary-focus underline hover:no-underline transition-colors font-medium">$1</a>',
      );
  }
</script>

<div class="mx-auto w-full max-w-full sm:max-w-2xl sm:py-6">
  <div>
    {#if profile?.banner}
      <img
        class="aspect-[3/1] w-full border border-base-300 dark:border-base-800 object-cover sm:rounded-xl sm:border"
        src={profile.banner}
        alt=""
      />
    {:else}
      <div class="aspect-[3/1] w-full bg-accent-100 dark:bg-base-900 border border-base-300 dark:border-base-800 object-cover sm:rounded-xl sm:border"></div>
    {/if}
  </div>
  <div
    class={[
      profile?.banner ? "-mt-8" : "-mt-8",
      "flex max-w-full items-end space-x-4 px-4 sm:-mt-6 sm:px-6 lg:px-4",
    ]}
  >
    <UserAvatar
      src={profile?.avatar}
      name={profile?.did || profile?.handle || "unknown"}
      class="size-22 sm:size-20 outline rounded-full outline-base-100 dark:outline-base-950"
    />

    <div
      class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6"
    >
      <div
        class={[
          profile?.banner,
          "flex min-w-0 max-w-full flex-1 flex-col items-baseline",
        ]}
      >
        <div
          class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1"
        >
          <h1
            class="max-w-full truncate text-xl font-bold text-base-900 dark:text-base-100 sm:text-xl"
          >
            {profile?.displayName || profile?.handle}
          </h1>
          {#if profile?.pronouns}
            <Badge variant="secondary" size="sm" class="shrink-0 font-normal">
              {profile.pronouns}
            </Badge>
          {/if}
        </div>
        {#if profile?.handle}
          <a
            href="https://aturi.to/{profile.did}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-accent-600 dark:text-accent-400 transition-colors font-medium"
          >
            @{profile.handle}
          </a>
        {/if}
        {#if profile?.website}
          <a
            href={websiteHref(profile.website)}
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-w-0 max-w-full items-center gap-1.5 text-sm text-accent-600 dark:text-accent-400 transition-colors font-medium hover:underline"
          >
            <IconGlobe class="size-3.5 shrink-0" />
            <span class="truncate">{websiteLabel(profile.website)}</span>
          </a>
        {/if}
      </div>
      {#if actions}
        <div class="shrink-0">
          {@render actions()}
        </div>
      {/if}
    </div>
  </div>

  {#if profile?.description}
    <div
      class="px-6 sm:px-4 lg:px-6 py-4 text-sm sm:text-sm text-base-900 dark:text-base-100 prose prose-sm dark:prose-invert prose-a:text-accent-600 dark:prose-a:text-accent-400"
    >
      {@html linkifyText(profile.description)}
    </div>
  {/if}
</div>
