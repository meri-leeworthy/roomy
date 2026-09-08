<script lang="ts">
  import { Button } from "bits-ui";

  export type SuggestionItem = {
    value: string;
    label: string;
    disabled?: boolean;
    category: string;
    [x: string]: unknown;
  };

  type Props = {
    items: SuggestionItem[];
    callback: ({ id, label }: { id: string; label: string }) => void;
  };

  let activeIndex = $state(0);

  let { items, callback }: Props = $props();

  let categories = $derived.by(() => {
    const name = new Set<string>();
    items.map((i) => name.add(i.category));
    return [...name.values()];
  });

  export function setItems(value: SuggestionItem[]) {
    items = value;
  }
  export function onKeyDown(event: KeyboardEvent) {
    if (event.repeat) {
      return false;
    }
    switch (event.key) {
      case "ArrowUp": {
        if (items.length === 0) return false;
        if (activeIndex <= 0) {
          activeIndex = items.length - 1;
        } else {
          activeIndex--;
        }
        return true;
      }
      case "ArrowDown": {
        if (items.length === 0) return false;
        if (activeIndex >= items.length - 1) {
          activeIndex = 0;
        } else {
          activeIndex++;
        }
        return true;
      }
      case "Enter": {
        // Always consume Enter while the suggestion popup is open: with no
        // matching items there is nothing to select, and the key must not fall
        // through to the composer's send keymap (or crash on an empty list).
        const selected = items[activeIndex];
        if (selected) callback({ id: selected.value, label: selected.label });
        return true;
      }
    }

    return false;
  }
</script>

<menu class="p-4 flex flex-col gap-3">
  {#each categories as category, c}
    {@const prevCategoryLength =
      c === 0
        ? 0
        : items.filter((i) => i.category === categories[c - 1]).length}
    <h5 class="uppercase text-gray-300">{category}</h5>
    {#each items.filter((i) => i.category === category) as { value, label, disabled }, i (i + value)}
      {@const actualIndex = i + prevCategoryLength}
      <Button.Root
        {disabled}
        class={[
          actualIndex === activeIndex && "!border border-accent-500",
          "px-3 py-2 flex gap-4 bg-base text-base-900 dark:text-base-100 rounded cursor-pointer",
        ]}
        onmouseover={() => (activeIndex = actualIndex)}
        onclick={() => callback({ id: value, label })}
      >
        {label}
      </Button.Root>
    {/each}
  {/each}
</menu>
