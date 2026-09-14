/**
 * XRPC: space.roomy.admin.reconcileProMembers (procedure).
 *
 * On-demand Roomy Pro members-role reconciliation. Runs one sweep of the
 * `billing/proRoleReconcile.ts` reconciler against the Roomy Space's
 * 'Members' role — adding paying Roomy Pro subscribers and removing lapsed
 * tracked ones — then reports what changed.
 *
 * This is the operator-triggered companion to the periodic sweep (wired in
 * the appserver factory). It shares the exact same fail-safe semantics:
 * on a Polar outage, no role mutation is performed and the endpoint reports
 * `failed: true` rather than guessing a user set.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`). No lexicon —
 * inline admin endpoint following the admin.getSpaceMembership pattern.
 * Polar disabled (no POLAR_ACCESS_TOKEN) → 503.
 */

import { getStreamManager } from "../streams/StreamManager.ts";
import { openReadStateDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { getPolar } from "../billing/polar.ts";
import {
  reconcileProMembers,
  type ReconcileResult,
} from "../billing/proRoleReconcile.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const adminReconcileProMembersHandler: ProcedureHandler<
  Record<string, unknown>,
  ReconcileResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const config = getPolar();
  if (!config) {
    throw new XrpcError(
      503,
      "ServiceUnavailable",
      "Polar billing is not configured",
    );
  }

  const writerDid = getStreamManager()
    .ownDid;

  return await reconcileProMembers(
    openReadStateDb(),
    config,
    writerDid,
  );
};
