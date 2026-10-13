<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import SpaceRoomBadge from "./SpaceRoomBadge.svelte";
  import type {
    RoomSummaryResolver,
    SpaceSummaryResolver,
  } from "./types";

  const { Story } = defineMeta({
    title: "Content/Thread/Message/Embeds/SpaceRoomBadge",
    component: SpaceRoomBadge,
  });

  const spaceId = "did:plc:drzgt2m6lmcel62gfbzjeap3";
  const roomId = "01KZBRQMEP2FTE079YRVDFKGTA";

  const space: SpaceSummaryResolver = async () => ({
    name: "Meri's Forest",
    avatar: "atblob://did:plc:drzgt2m6lmcel62gfbzjeap3/bafkreiexampleavatar",
  });

  /** A space link whose target the appserver holds no row for — a stale link. */
  const unknownSpace: SpaceSummaryResolver = async () => undefined;

  const channel: RoomSummaryResolver = async () => ({
    name: "lobby",
    kind: "channel",
    spaceId,
  });

  const thread: RoomSummaryResolver = async () => ({
    name: "weekly roll-up",
    kind: "thread",
    spaceId,
  });

  const unknownRoom: RoomSummaryResolver = async () => undefined;
</script>

{#snippet template(args: {
  spaceId?: string;
  roomId?: string;
  href: string;
  linkText?: string;
  resolveSpace: SpaceSummaryResolver;
  resolveRoom?: RoomSummaryResolver;
  isCurrentSpace?: () => boolean;
})}
  <div class="p-4 text-sm bg-base-50 dark:bg-base-950 text-base-900 dark:text-base-100">
    <SpaceRoomBadge
      spaceId={args.spaceId ?? spaceId}
      roomId={args.roomId}
      href={args.href}
      linkText={args.linkText}
      resolveSpace={args.resolveSpace}
      resolveRoom={args.resolveRoom}
      isCurrentSpace={args.isCurrentSpace}
    />
  </div>
{/snippet}

<Story
  name="Space"
  args={{ href: `/${spaceId}`, resolveSpace: space }}
  {template}
/>

<Story
  name="SpaceAndChannel"
  args={{
    href: `/${spaceId}/${roomId}`,
    roomId,
    resolveSpace: space,
    resolveRoom: channel,
  }}
  {template}
/>

<Story
  name="SpaceAndThread"
  args={{
    href: `/${spaceId}/${roomId}`,
    roomId,
    resolveSpace: space,
    resolveRoom: thread,
  }}
  {template}
/>

<Story
  name="ExplicitLinkText"
  args={{
    href: `/${spaceId}/${roomId}`,
    roomId,
    linkText: "the planning thread",
    resolveSpace: space,
    resolveRoom: channel,
  }}
  {template}
/>

<Story
  name="CurrentSpace"
  args={{
    href: `/${spaceId}/${roomId}`,
    roomId,
    linkText: "the planning thread",
    resolveSpace: space,
    resolveRoom: channel,
    isCurrentSpace: () => true,
  }}
  {template}
/>

<Story
  name="Unresolved"
  args={{
    spaceId: "did:plc:e2eabsent0000000000000000",
    roomId: "01M3FPE5JXZN84WG1AMBPW3951",
    href: "/did:plc:e2eabsent0000000000000000/01M3FPE5JXZN84WG1AMBPW3951",
    resolveSpace: unknownSpace,
    resolveRoom: unknownRoom,
  }}
  {template}
/>
