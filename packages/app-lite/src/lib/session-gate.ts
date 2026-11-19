/**
 * The session gate the sync connection and the session layer share.
 *
 * Both sides need the same object: the session layer is the only code that
 * sees the session origin refuse or accept a request, and the sync connection
 * is the only code that spends a session request on a connection ticket it
 * cannot use. Sharing one gate is what makes "stop" and "resume" refer to the
 * same session.
 *
 * Only two of the app's session paths are observable here:
 * `session-health.ts` calls `recover()` when the session origin answers a
 * request, and the SDK marks the gate rejected when a ticket fetch is refused
 * by the session rather than by the appserver. This build can only do the
 * first when a HappyView endpoint is configured — the legacy direct-PDS client
 * has no single session origin to watch — so the gate is absent in that case:
 * a loop waiting for a signal that can never arrive would never resume, and
 * the connection's ordinary backoff is the better outcome.
 */

import { sync } from "@roomy-space/sdk";

import { CONFIG } from "./config";

export const syncSessionGate: sync.SessionGate | null = CONFIG.happyviewEndpoint
  ? new sync.SessionGate()
  : null;
