<script lang="ts" module>
  export type ReactionGroup = {
    emoji: string;
    count: number;
    /** Whether the current user has reacted with this emoji. */
    pressed: boolean;
  };

  export type ReactorInfo = {
    did: string;
    name: string;
    handle?: string;
    avatar?: string;
  };
</script>

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { PopoverEmojiPicker } from "@foxui/social";
  import { Toggle } from "@foxui/core";
  import { Tooltip } from "bits-ui";
  import Button from "../../../ui/button/Button.svelte";
  import { IconSmilePlus } from "../../../../icons/index";
  import LoadingSpinner from "../../../helper/LoadingSpinner.svelte";

  let {
    reactions,
    onToggleReaction,
    onHover,
    tooltipOpenByEmoji = {},
    tooltipReactorsByEmoji = {},
  }: {
    reactions: ReactionGroup[];
    /** Called when the user clicks an emoji (either existing reaction or picker). */
    onToggleReaction: (emoji: string) => void;
    /** Called when the user hovers over an emoji button. Receives the emoji string. */
    onHover?: (emoji: string) => void;
    /** Per-emoji tooltip open state, controlled by the parent after fetch completes. */
    tooltipOpenByEmoji?: Record<string, boolean>;
    /** Per-emoji reactor data for tooltip rendering. */
    tooltipReactorsByEmoji?: Record<string, ReactorInfo[]>;
  } = $props();

  let isEmojiRowPickerOpen = $state(false);

  // ── Mobile long-press to reveal the reactor list ────────────────────────
  // Touch devices have no hover, so a long-press on a reaction emoji opens the
  // same reactor-list tooltip that desktop hover shows. A short tap still
  // toggles the reaction. We use a touch timer (the reliable cross-browser
  // long-press signal) and also intercept `contextmenu` (which iOS/Android
  // fire on long-press) so it doesn't bubble up to the message's own
  // long-press handler (the mobile message menu).
  let isCoarse = new MediaQuery("(pointer: coarse)");
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTriggered = false;

  function onTouchStart(emoji: string) {
    longPressTriggered = false;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      onHover?.(emoji);
    }, 500);
  }
  function onTouchEnd() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  function onTouchMove() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function handlePick(emoji: string) {
    onToggleReaction(emoji);
    isEmojiRowPickerOpen = false;
  }
</script>

{#if reactions.length > 0}
  <div class="flex gap-2 items-center flex-wrap pl-12 z-10">
    {#each reactions as { emoji, count, pressed } (emoji)}
      <Tooltip.Root
        open={tooltipOpenByEmoji[emoji] ?? false}
        onOpenChange={(o) => {
          tooltipOpenByEmoji[emoji] = o;
        }}
      >
        <div class="inline-flex" role="presentation">
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Toggle
                pressed={pressed}
                {...props}
                onmouseover={() => onHover?.(emoji)}
                ontouchstart={() => onTouchStart(emoji)}
                ontouchend={onTouchEnd}
                ontouchmove={onTouchMove}
                oncontextmenu={(e) => {
                  // On touch devices, long-press reveals the reactor list
                  // instead of bubbling up to the message's long-press handler
                  // (mobile menu).
                  if (isCoarse.current) {
                    e.preventDefault();
                    e.stopPropagation();
                    longPressTriggered = true;
                    onHover?.(emoji);
                  }
                }}
                onclick={() => {
                  // A long-press (which already opened the reactor list) also
                  // fires a click on release — don't toggle the reaction then.
                  if (longPressTriggered) {
                    longPressTriggered = false;
                    return;
                  }
                  onToggleReaction(emoji);
                }}
                class={`h-7 data-[state=on]:bg-accent-400/20 dark:data-[state=on]:bg-accent-500/15 min-w-4 p-1.5 rounded-full ${count > 1 ? "px-2" : ""}`}
              >
                <span>{emoji}</span>
                {#if count > 1}
                  <span class="text-xs font-semibold text-base-900 dark:text-base-100">
                    {count}
                  </span>
                {/if}
              </Toggle>
            {/snippet}
          </Tooltip.Trigger>
        </div>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            class="z-50"
          >
            {#if (tooltipReactorsByEmoji[emoji] ?? []).length === 0}
              <div
                class="rounded-lg border-base-200 dark:border-base-800 shadow-xs bg-base-50/50 dark:bg-base-900/50 backdrop-blur-md outline-hidden flex items-center justify-center border p-2"
              >
                <LoadingSpinner size={16} />
              </div>
            {:else}
              <div
                class="rounded-lg border-base-200 dark:border-base-800 shadow-xs bg-base-50/50 dark:bg-base-900/50 backdrop-blur-md text-base-800 dark:text-base-200 outline-hidden flex flex-col gap-1.5 border p-2 min-w-[180px]"
              >
                {#each tooltipReactorsByEmoji[emoji] as reactor (reactor.did)}
                  <div class="flex items-center gap-2">
                    {#if reactor.avatar}
                      <img
                        src={reactor.avatar}
                        alt=""
                        class="size-5 rounded-full object-cover flex-shrink-0"
                      />
                    {:else}
                      <div class="size-5 rounded-full bg-base-200 dark:bg-base-700 flex-shrink-0"></div>
                    {/if}
                    <span class="text-sm truncate">{reactor.name}</span>
                    {#if reactor.handle}
                      <span class="text-xs text-base-500 dark:text-base-400 truncate">@{reactor.handle}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    {/each}

    <PopoverEmojiPicker
      bind:open={isEmojiRowPickerOpen}
      onpicked={(emoji) => handlePick(emoji.unicode)}
      search
      favorites
    >
      {#snippet child({ props })}
        <Button size="icon" variant="ghost" {...props} class="p-1.5">
          <IconSmilePlus class="text-primary" />
        </Button>
      {/snippet}
    </PopoverEmojiPicker>
  </div>
{/if}
