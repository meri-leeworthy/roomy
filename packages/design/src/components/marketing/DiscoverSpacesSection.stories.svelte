<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import DiscoverSpacesSection from "./DiscoverSpacesSection.svelte";
  import DiscoverSpaceCard from "./DiscoverSpaceCard.svelte";

  const { Story } = defineMeta({
    title: "Marketing/DiscoverSpacesSection",
    component: DiscoverSpacesSection,
  });

  const ids = [
    "did:plc:4moccs43r5v2xzkynae3xk2u",
    "did:plc:gnwy2zbm3hu4gfdawzxmpb2s",
    "did:plc:abcdefghijklmnopqrstuvwx",
  ];

  const resolved = [
    { id: ids[0]!, name: "Community Garden", description: "Plot swaps, seed libraries and the tomato report." },
    { id: ids[1]!, name: "Book Club" },
    { id: ids[2]!, pending: true },
  ];
</script>

{#snippet template(args: { spaceIds: string[]; cards: typeof resolved })}
  <div class="w-full">
    <DiscoverSpacesSection spaceIds={args.spaceIds} onDismiss={() => {}}>
      {#snippet card(spaceId: string)}
        {@const space = args.cards.find((c) => c.id === spaceId) ?? { id: spaceId }}
        <DiscoverSpaceCard {space} />
      {/snippet}
    </DiscoverSpacesSection>
  </div>
{/snippet}

<Story name="Resolved" args={{ spaceIds: ids, cards: resolved }} {template} />

<Story
  name="Failed"
  args={{ spaceIds: [ids[0]!], cards: [{ id: ids[0]!, failed: true }] }}
  {template}
/>

<Story name="Empty" args={{ spaceIds: [], cards: [] }} {template} />
