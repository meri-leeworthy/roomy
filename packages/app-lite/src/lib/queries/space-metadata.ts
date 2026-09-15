import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export function createSpaceMetadataQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMetadata", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getMetadata", {
        spaceId: spaceId(),
      }),
    // Any part of `enabled` derived from reactive state must be an accessor,
    // or it freezes at first evaluation (Svelte `state_referenced_locally`).
    // See the fuller note on createRoomMetadataQuery.
    enabled:
      typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled,
  }));
}
