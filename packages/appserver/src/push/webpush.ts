/**
 * Web Push transport (VAPID + the `web-push` library).
 *
 * The appserver holds a VAPID keypair (env: `VAPID_PRIVATE_KEY`,
 * `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`). The public key is handed to browsers
 * so they can create a `PushSubscription`; the private key signs the VAPID
 * JWT used for delivery. `web-push` (pure JS, runs under Bun) handles VAPID
 * JWT signing + RFC 8291 (`aes128g2`) payload encryption and POSTs the
 * encrypted body to each subscription's push-service endpoint.
 *
 * This is the first {@link PushTransport}; it registers itself in
 * `PUSH_TRANSPORTS` at module load, so importing this module is what makes Web
 * Push rows deliverable. Generate a keypair once per environment with
 * `scripts/generate-vapid.ts`. Delivery is a no-op until VAPID is configured,
 * so the appserver boots and serves the lexicons even without keys.
 */

import webPush, { type PushSubscription, type WebPushError } from "web-push";
import { log } from "../log.ts";
import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTransport,
  type PushTarget,
} from "./transport.ts";

const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "";

let configured = false;

/** Configure the global VAPID details once. Idempotent and cheap to call. */
function ensureConfigured(): void {
  if (configured) return;
  if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY || !VAPID_SUBJECT) {
    // Push delivery is disabled until env keys are present. The lexicons
    // and handlers still work (getVapidPublicKey returns null, register/
    // setPreferences store state); only actual delivery is skipped.
    return;
  }
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

/** Whether VAPID is configured and delivery is enabled. */
export function isPushConfigured(): boolean {
  ensureConfigured();
  return configured;
}

/**
 * The VAPID public key to hand to browsers
 * (`pushManager.subscribe({ applicationServerKey })`), or null when VAPID
 * isn't configured.
 */
export function getVapidPublicKey(): string | null {
  ensureConfigured();
  return VAPID_PUBLIC_KEY || null;
}

interface SendPushResult {
  /** HTTP status from the push service, or null if delivery was skipped. */
  status: number | null;
  /** True when the push service indicated the subscription is gone (404/410). */
  gone: boolean;
}

/**
 * Deliver an encrypted payload to a single subscription endpoint. Internal to
 * this module — callers reach Web Push through the registered transport below,
 * so the transport is the only delivery surface the rest of the appserver uses.
 *
 * - Returns `{ status: 2xx, gone: false }` on success.
 * - Returns `{ gone: true }` on 404/410 so the caller can prune the row.
 * - On 429/5xx the promise rejects so the caller can apply backoff.
 * - When VAPID isn't configured, delivery is skipped (resolves with null
 *   status) so the rest of the system stays usable in dev/test.
 */
async function sendPush(
  subscription: PushSubscription,
  payload: string,
  options: PushDeliveryOptions = {},
): Promise<SendPushResult> {
  ensureConfigured();
  if (!configured) {
    log.debug("[push] delivery skipped — VAPID not configured");
    return { status: null, gone: false };
  }

  try {
    await webPush.sendNotification(subscription, payload, {
      TTL: options.ttl ?? 2419200, // 4 weeks default
      urgency: options.urgency ?? "normal",
      topic: options.topic,
    });
    return { status: 200, gone: false };
  } catch (err) {
    const e = err as WebPushError;
    const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
    // 404/410 = subscription no longer valid (expired / user unsubscribed).
    // Surface as `gone` so the caller prunes the row instead of retrying.
    if (status === 404 || status === 410) {
      return { status, gone: true };
    }
    // 429 / 5xx and anything else — reject so the caller can back off.
    throw err;
  }
}

/**
 * Web Push as a seam transport: the wire call plus the outcome vocabulary the
 * dispatcher consumes (`gone` on 404/410, `retry` on a throw, with the
 * push-service status the wire gave). The `PushTarget.endpoint` is the
 * push-service URL and `p256dh`/`auth` are the RFC 8291 keys — the fields a
 * registered browser subscription carries.
 */
const webPushTransport: PushTransport = {
  kind: "webpush",
  async deliver(
    target: PushTarget,
    body: string,
    options: PushDeliveryOptions,
  ): Promise<PushOutcome> {
    try {
      const res = await sendPush(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh ?? "", auth: target.auth ?? "" },
          expirationTime: target.expirationTime,
        },
        body,
        options,
      );
      return res.gone
        ? { outcome: "gone", status: res.status }
        : { outcome: "delivered", status: res.status };
    } catch (error) {
      // `sendPush` rejects with a `WebPushError` on 429/5xx; narrow rather than
      // assume the shape, and report the status for diagnostics.
      const status = (error as WebPushError)?.statusCode;
      return {
        outcome: "retry",
        status: typeof status === "number" ? status : null,
        error,
      };
    }
  },
};

PUSH_TRANSPORTS[webPushTransport.kind] = webPushTransport;