<script lang="ts">
  import { Avatar, type WithoutChildrenOrChild } from "bits-ui";
  import { AvatarBeam } from "svelte-boring-avatars";

  let {
    src,
    name = "unknown",
    size = 32,
    class: className,
    ...restProps
  }: WithoutChildrenOrChild<Avatar.RootProps> & {
    /** Image URL for the avatar. Falls back to a generated boring avatar on error. */
    src?: string;
    /** Seed for the generated boring avatar (e.g. DID, handle). */
    name?: string;
    /** Size of the boring avatar in pixels when the image fails. */
    size?: number;
    /** Additional classes for the root element. */
    class?: string;
  } = $props();
</script>

<Avatar.Root class={`overflow-hidden rounded-full ${className ?? ""}`} {...restProps}>
  <Avatar.Image {src} class="h-full w-full object-cover object-center rounded-full" />
  <Avatar.Fallback class="block h-full w-full">
    <div class="avatar-fallback h-full w-full">
      <AvatarBeam {name} {size} />
    </div>
  </Avatar.Fallback>
</Avatar.Root>

<style>
  /* The boring-avatar SVG is rendered at a fixed pixel size; scale it to
     fill whatever container the fallback sits in (e.g. the responsive 40px
     chat avatar) instead of leaving it undersized. */
  .avatar-fallback :global(svg) {
    width: 100%;
    height: 100%;
  }
</style>
