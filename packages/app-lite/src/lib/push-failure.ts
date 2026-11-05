/**
 * What a failed push subscribe attempt means to the user and to us.
 *
 * `subscribeIfAlreadyPermitted` runs on every sign-in without a user gesture,
 * so it is the one place a broken push service shows up with nobody watching:
 * the rejection lands in the console and, before this existed, nothing else
 * happened. This module turns a {@link PushOutcome} into the two things a
 * console line cannot give — a countable telemetry event and (for the failures
 * that are genuinely news) a single in-app notice — as pure functions, so the
 * rules are testable without a browser.
 *
 * The reactive half lives in `push-notice.svelte.ts`.
 */

import type { PushOutcome } from "./push.svelte";
import type { EventAttributes } from "./telemetry/faro";

/** Faro event name: a sign-in re-subscribe that produced no subscription. */
export const PUSH_LOGIN_FAILURE_EVENT = "push_login_failure";

/**
 * The failures worth counting and, once, telling the user about.
 *
 * `no-key`, `unsupported` and `denied` are deliberately absent: they are
 * expected states that the settings page already explains, and `denied` in
 * particular recurs on every sign-in for a user who blocked notifications, so
 * surfacing it would nag without telling anyone anything new.
 */
export type PushFailure = { status: "failed"; message: string } | { status: "timeout" };

/** The dedupe unit: one notice per failure class per session. */
export type PushFailureClass = PushFailure["status"];

/**
 * The failure to act on, or `null` when the outcome needs neither a count nor
 * a notice. `null` outcome means the attempt never happened (no remembered
 * native token, no push support, permission not granted) — see
 * `subscribeIfAlreadyPermitted`.
 */
export function toPushFailure(outcome: PushOutcome | null): PushFailure | null {
  if (outcome === null) return null;
  switch (outcome.status) {
    case "failed":
      return { status: "failed", message: outcome.message };
    case "timeout":
      return { status: "timeout" };
    default:
      return null;
  }
}

/**
 * Strip anything that could identify the device or a session before a failure
 * detail leaves the browser: push endpoints are per-device capability URLs
 * (deliverable for the subscription's life) and an XRPC payload can echo the
 * request. The detail is truncated as well, since this is an event attribute,
 * not a log sink.
 */
export function scrubPushDetail(message: string): string {
  const withoutUrls = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
  const trimmed = withoutUrls.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Event attributes for one login-time failure: the class always, the detail
 * only for `failed` (the other class has no message to carry).
 */
export function pushFailureAttributes(failure: PushFailure): EventAttributes {
  if (failure.status === "failed") {
    return { status: failure.status, message: scrubPushDetail(failure.message) };
  }
  return { status: failure.status };
}

/**
 * Claim the right to show a notice for this failure class. `admitted` is the
 * session's record of classes already surfaced, so a push service that fails
 * on every sign-in produces one notice, not a steady drip.
 */
export function admitPushFailure(
  failure: PushFailure,
  admitted: Set<PushFailureClass>,
): boolean {
  if (admitted.has(failure.status)) return false;
  admitted.add(failure.status);
  return true;
}
