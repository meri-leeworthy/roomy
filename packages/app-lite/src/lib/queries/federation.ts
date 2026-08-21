import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Pending federation requests *addressed to* this space (A): another space
 * (B) wants to federate into A. Visible to A's admins, who approve/reject.
 */
export function createFederationRequestsQuery(spaceId: () => string, opts?: { enabled?: boolean | (() => boolean) }) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.federation.getRequests", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.federation.getRequests", { spaceId: spaceId() }),
    enabled: typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled,
  }));
}

/**
 * Federations *into* this space (B): origin spaces exposing channels to B.
 * Visible to B's admins, who configure receiver grants.
 */
export function createFederationIncomingQuery(spaceId: () => string, opts?: { enabled?: boolean | (() => boolean) }) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.federation.getIncoming", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.federation.getIncoming", { spaceId: spaceId() }),
    enabled: typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled,
  }));
}

/**
 * Federations *from* this space (A): spaces B that A exposes channels to.
 * Visible to A's admins, who configure origin grants.
 */
export function createFederationOutgoingQuery(spaceId: () => string, opts?: { enabled?: boolean | (() => boolean) }) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.federation.getOutgoing", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.federation.getOutgoing", { spaceId: spaceId() }),
    enabled: typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled,
  }));
}

/**
 * Origin + receiver per-channel grants touching this space (admin-only).
 * Feeds the settings Federations grant toggles.
 */
export function createFederationGrantsQuery(spaceId: () => string, opts?: { enabled?: boolean | (() => boolean) }) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.federation.getGrants", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.federation.getGrants", { spaceId: spaceId() }),
    enabled: typeof opts?.enabled === "function" ? opts.enabled() : opts?.enabled,
  }));
}
