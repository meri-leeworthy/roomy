import { px } from "$lib/auth.svelte";
import { bridgeTokensQueryKey } from "$lib/queries/bridge-tokens";
import { queryClient } from "$lib/client";

/**
 * Dedicate the caller's Roomy Pro bridge token to a space. One active grant
 * per grantor: if a pending grant already exists (here or elsewhere) the
 * appserver rejects with 409 `AlreadyGranted`; a spent grant rejects with 409
 * `AlreadySpent`. A non-Pro caller is rejected with 403 `NotProMember`.
 */
export async function grantBridgeToken(
  spaceId: string,
): Promise<{ status: "pending"; capacity: number }> {
  const result = await px().procedure("space.roomy.space.grantBridgeToken", {
    spaceId,
  });
  await queryClient.invalidateQueries({
    queryKey: bridgeTokensQueryKey(spaceId),
  });
  return result;
}

/**
 * Free the caller's grant for a space so their membership can be used
 * elsewhere. Grantor-only; a spent grant is permanent and the appserver
 * rejects the revoke with 409 `AlreadySpent`.
 */
export async function revokeBridgeToken(spaceId: string): Promise<void> {
  await px().procedure("space.roomy.space.revokeBridgeToken", { spaceId });
  await queryClient.invalidateQueries({
    queryKey: bridgeTokensQueryKey(spaceId),
  });
}

/**
 * The appserver's XRPC error name for a failed grant/revoke call, if any.
 * Used to map 409/403 responses onto actionable copy.
 */
export function xrpcErrorName(err: unknown): string | undefined {
  if (err && typeof err === "object" && "errorType" in err) {
    const name = (err as { errorType?: unknown }).errorType;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}
