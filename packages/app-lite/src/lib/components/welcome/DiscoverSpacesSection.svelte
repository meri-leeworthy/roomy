<script lang="ts">
  /**
   * Discoverable spaces section. The list is the server's answer to
   * `getDiscoverableSpaces`, which already excludes spaces that opted out of
   * being suggested or that are not public to join — the client renders it and
   * only removes spaces the reader has already joined and cards dismissed in
   * this session.
   *
   * The strip's frame is `@roomy/design`'s; this wrapper owns what is
   * discoverable and resolves each card's metadata.
   */
  import DiscoverSpacesSectionShell from "@roomy/design/components/marketing/DiscoverSpacesSection.svelte";
  import DiscoverSpaceCard from "./DiscoverSpaces.svelte";
  import { createSpacesQuery } from "$lib/queries/spaces";
  import { createDiscoverableSpacesQuery } from "$lib/queries/discoverable-spaces";

  const discoverQuery = createDiscoverableSpacesQuery();

  // Cached query of the user's joined spaces. The query refetches on mount
  // (it is a pulled view — see `queries/spaces.ts`), so this costs one request
  // per mount of this section rather than sharing the homepage's.
  const spacesQuery = createSpacesQuery();

  // DIDs the user is currently a member of.
  const joinedIds = $derived(
    new Set(
      (spacesQuery.data?.spaces ?? [])
        .filter((s) => s.isMember)
        .map((s) => s.id),
    ),
  );

  let dismissed = $state<Set<string>>(new Set());

  const visible = $derived(
    (discoverQuery.data?.spaces ?? [])
      .map((s) => s.id)
      .filter((id) => !dismissed.has(id) && !joinedIds.has(id)),
  );

  function dismiss(id: string) {
    dismissed = new Set([...dismissed, id]);
  }
</script>

<DiscoverSpacesSectionShell spaceIds={visible} onDismiss={dismiss}>
  {#snippet card(spaceId)}
    <DiscoverSpaceCard {spaceId} />
  {/snippet}
</DiscoverSpacesSectionShell>
