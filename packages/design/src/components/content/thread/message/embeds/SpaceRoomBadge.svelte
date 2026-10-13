<script lang="ts">
  /**
   * SpaceRoomBadge — the inline reference a space or room link collapses to:
   * avatar + label, with the room's kind icon when the link names a room.
   *
   * Presentational only. The lookups that populate it arrive as
   * {@link SpaceSummaryResolver} / {@link RoomSummaryResolver} props, so the
   * component neither owns an XRPC client nor decides the request policy for
   * the summary queries (see `types.ts`).
   */
  import { resolveBlobUrl } from "@roomy/design/utils";
  import { IconNeedleThread, IconChevronRight } from "@roomy/design/icons";
  import SpaceAvatar from "@roomy/design/components/spaces/SpaceAvatar.svelte";
  import type {
    RoomSummary,
    RoomSummaryResolver,
    SpaceSummary,
    SpaceSummaryResolver,
  } from "./types";

  let {
    spaceId,
    roomId,
    href,
    linkText,
    resolveSpace,
    resolveRoom,
    isCurrentSpace = () => false,
  }: {
    spaceId: string;
    roomId?: string;
    href: string;
    /** Explicit link text from a markdown link like [text](/did:plc:xxx). When set, use this instead of space/room names. */
    linkText?: string;
    resolveSpace: SpaceSummaryResolver;
    resolveRoom?: RoomSummaryResolver;
    /**
     * Whether the space this badge names is the one the reader is currently
     * in. That badge is suppressed to a plain label — repeating the space's
     * own name inside its own messages says nothing.
     */
    isCurrentSpace?: () => boolean;
  } = $props();

  let spaceSummary = $state<SpaceSummary>();
  let roomSummary = $state<RoomSummary>();

  // Both lookups are read-only render inputs: a rejection leaves the badge in
  // its fallback state rather than taking the message row down with it.
  $effect(() => {
    const id = spaceId;
    let stale = false;
    spaceSummary = undefined;
    void resolveSpace(id).then(
      (summary) => {
        if (!stale) spaceSummary = summary;
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  });

  $effect(() => {
    const id = roomId;
    let stale = false;
    roomSummary = undefined;
    if (!id || !resolveRoom) return;
    void resolveRoom(id).then(
      (summary) => {
        if (!stale) roomSummary = summary;
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  });

  const spaceName = $derived(spaceSummary?.name ?? spaceId);
  const roomName = $derived(roomSummary?.name);
</script>

<a {href} class="mention not-prose !no-underline whitespace-nowrap">
  {#if !isCurrentSpace()}
    <span class="inline-block align-middle">
      <SpaceAvatar
        src={resolveBlobUrl(spaceSummary?.avatar)}
        id={spaceId}
        name={spaceName}
        size={14}
      />
    </span>
    <span class="align-middle">{linkText ?? spaceName}</span>
    {#if roomId}
      <IconChevronRight class="opacity-40 size-3 inline align-middle" />
    {/if}
  {:else if linkText}
    <span class="align-middle">{linkText}</span>
  {/if}
  {#if roomId}
    {#if roomSummary?.kind === "thread"}
      <IconNeedleThread class="opacity-60 size-3.5 inline align-middle" />
    {:else}
      <span class="opacity-60 align-middle">#</span>
    {/if}
    <span class="align-middle">{roomName ?? roomId}</span>
  {/if}
</a>
