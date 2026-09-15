import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Invite = typeof schemas.queries.getInvites.Invite.infer;

/**
 * Invites are admin/member-invite gated on the appserver: for a non-admin in a
 * space with member invites off the query 403s. Callers that only render
 * invites behind a modal MUST pass `enabled` so the request is not issued on
 * mount — an unconditional query spams the appserver log with 403s for every
 * space a member opens.
 */
export function createInvitesQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean | (() => boolean) },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getInvites", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getInvites", { spaceId: spaceId() }),
    enabled: typeof opts?.enabled === "function" ? opts.enabled() : (opts?.enabled ?? true),
    // A 403 from the invite policy will never succeed on retry, and TanStack's
    // default `retry: 3` turns one modal open into four 403s in the appserver
    // log. Transport-level retries (rate limits) live in DirectXrpcClient.
    retry: false,
  }));
}
