import { createQuery } from "@tanstack/svelte-query";
import { cache, Did, type } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export function createSpaceMetadataQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => {
    const id = spaceId();
    return {
      queryKey: queryKey("space.roomy.space.getMetadata", { spaceId: id }),
      queryFn: () =>
        px().query("space.roomy.space.getMetadata", {
          spaceId: id,
        }),
      // This is the space-entry query — the layout it feeds is mounted for
      // EVERY `/foo` route, and the route param it derives its id from is a
      // non-null-asserted `page.params.space` (so it types as `string` even
      // while holding a non-DID like `/profile` or `/muni-town`).
      //
      // Two guards stop a non-space or genuinely-missing space from spamming
      // the appserver:
      //  - `enabled`: a non-DID first path segment is never a space, so the
      //    query stays disabled and issues no request. The `[space]` layout
      //    rejects non-DIDs before mounting, but direct component mounters
      //    (NavbarSpaceInfo, DiscoverSpaces, …) still benefit from this gate.
      //  - `retry: false`: a genuinely-missing space 404s deterministically;
      //    retrying it is pointless. The TanStack default `retry: 3` turned
      //    one missing-space load into four `getMetadata -> 404` requests —
      //    the ~7 s TanStack ladder (gaps 1.05/2.05/4.1 s) seen in the logs.
      //    Transport-level retries (rate limits) live in DirectXrpcClient.
      enabled:
        id !== "" &&
        !(Did(id) instanceof type.errors) &&
        (typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled !== false),
      retry: false,
    };
  });
}
