/**
 * The in-app push notice, shared by the banner and the settings page.
 *
 * Two pieces of state, both fed by the places that attempt a subscription:
 *
 *  - `failure` — a login-time re-subscribe that left this device without
 *    notifications, shown once per session per failure class. See
 *    `push-failure.ts` for which outcomes count and why.
 *  - `lastOutcome` — the most recent attempt, whoever made it, so the settings
 *    page can show what actually happened on this device instead of implying
 *    "on" from the presence of a subscription.
 */

import type { PushOutcome } from "./push.svelte";
import {
  PUSH_LOGIN_FAILURE_EVENT,
  admitPushFailure,
  pushFailureAttributes,
  toPushFailure,
  type PushFailure,
  type PushFailureClass,
} from "./push-failure";
import { trackEvent } from "./telemetry/faro";

/** Failure classes already shown this session. */
const admitted = new Set<PushFailureClass>();

let failure = $state<PushFailure | null>(null);
let lastOutcome = $state<PushOutcome | null>(null);

export const pushNotice = {
  get failure() {
    return failure;
  },
  get lastOutcome() {
    return lastOutcome;
  },
  /** Hide the notice until the next failure class of this session. */
  dismiss() {
    failure = null;
  },
  /** Forget the last attempt — a disable is not a subscribe outcome. */
  forgetOutcome() {
    lastOutcome = null;
  },
};

/**
 * Record the outcome of a login-time re-subscribe: count it, and raise the
 * notice for the first failure of its class this session.
 *
 * Runs detached from login (`void … .then(noteLoginPushOutcome)`), so it must
 * never throw; the caller has nothing to catch it with.
 */
export function noteLoginPushOutcome(outcome: PushOutcome | null): void {
  try {
    if (outcome !== null) lastOutcome = outcome;
    const failed = toPushFailure(outcome);
    if (failed === null) return;
    trackEvent(PUSH_LOGIN_FAILURE_EVENT, pushFailureAttributes(failed));
    if (admitPushFailure(failed, admitted)) failure = failed;
  } catch (e) {
    console.warn("[push:login] could not record outcome:", e);
  }
}

/**
 * Record an attempt the user asked for (settings "Enable notifications", the
 * notice's "Retry"). Not deduped: the user is looking at the result of their
 * own click, and the notice tracks the latest attempt.
 */
export function notePushAttempt(outcome: PushOutcome): void {
  lastOutcome = outcome;
  failure = toPushFailure(outcome);
}

