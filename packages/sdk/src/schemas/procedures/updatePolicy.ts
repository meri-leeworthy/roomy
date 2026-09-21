/**
 * Schema for `space.roomy.space.updatePolicy` (procedure).
 *
 * Re-applies the reference arbiter config on a space's stewarded account.
 * Requires admin access on the space. The appserver, as the arbiter recovery
 * admin, calls `town.muni.arbiter.resetConfig` with the reference config
 * (the same config newly-provisioned spaces get).
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.updatePolicy" as const;

export const Input = type({
  spaceId: "string",
});

/** Void procedure — the appserver responds 200 with an empty body. */
export const Output = type({});
