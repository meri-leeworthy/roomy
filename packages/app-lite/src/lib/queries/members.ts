import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Member = typeof schemas.queries.getMembers.Member.infer;
export type ExternalAdmin = typeof schemas.queries.getMembers.ExternalAdmin.infer;

export function createMembersQuery(
  spaceId: () => string,
  search: () => string | undefined = () => undefined,
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMembers", {
      spaceId: spaceId(),
      ...(search() ? { search: search() } : {}),
    }),
    queryFn: () =>
      px().query("space.roomy.space.getMembers", {
        spaceId: spaceId(),
        ...(search() ? { search: search() } : {}),
      }),
    // Keep the previous member list rendered while a new search term fetches —
    // without this, each keystroke flips isPending and the list flashes the
    // loading state.
    placeholderData: keepPreviousData,
    // getMembers is member/admin-gated on the appserver (`requireSpaceAccess`):
    // a non-member 403s deterministically and will never succeed on retry.
    // Matches the invites/roles/bridge-tokens gate. TanStack's default
    // `retry: 3` multiplies one access failure into four requests. Transport
    // -level retries (rate limits) live in DirectXrpcClient.
    retry: false,
  }));
}
