import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type BridgeToken = typeof schemas.queries.getBridgeTokens.BridgeToken.infer;

/** Canonical query key, exported so mutations can invalidate the same entry. */
export function bridgeTokensQueryKey(spaceId: string): readonly unknown[] {
  return queryKey("space.roomy.space.getBridgeTokens", { spaceId });
}

/**
 * Lists the bridge-token grants a space has received. Member-accessible and
 * Polar-free: each grant carries its grant-time capacity snapshot and spent
 * status, so the settings page can tell whether the caller has dedicated
 * their Roomy Pro membership to this space.
 */
export function createBridgeTokensQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => ({
    queryKey: bridgeTokensQueryKey(spaceId()),
    queryFn: () =>
      px().query("space.roomy.space.getBridgeTokens", { spaceId: spaceId() }),
    enabled:
      typeof opts?.enabled === "function"
        ? opts.enabled()
        : (opts?.enabled ?? true),
    // A non-member 403 will never succeed on retry; the default retry: 3
    // turns one page load into four logged errors.
    retry: false,
  }));
}
