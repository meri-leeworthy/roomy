import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type Profile = typeof schemas.queries.getProfile.Profile.infer;

export function createProfileQuery(actor: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.user.getProfile", { actor: actor() }),
    queryFn: () =>
      px().query("space.roomy.user.getProfile", { actor: actor() }),
    // getProfile 404s (`ActorNotFound`) when the handle/actor doesn't
    // resolve — a deterministic existence check whose answer cannot change
    // by asking again. TanStack's default `retry: 3` turns one nonexistent
    // actor into four requests. Transport-level retries (rate limits) live
    // in DirectXrpcClient.
    retry: false,
  }));
}