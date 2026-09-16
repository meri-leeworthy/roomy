/**
 * Freshness gate for push delivery (TASK-151).
 *
 * A push is a *live* signal: "this just happened". Nothing in the push
 * pipeline enforced that. The only time a message carried was
 * `decodeTime(event.id)` — the event **ULID**, i.e. when the event was
 * *ingested*, not when the message was written. A replay of historical
 * messages therefore produced messages with fresh ULIDs and hours-old
 * content, and every downstream gate treated them as new.
 *
 * Observed production incident (2026-09-16): the Discord bridge's
 * `runBackfill` replay (`cursor: none`, historical Discord messages)
 * delivered historical messages over the live `sendEvents` path. It was
 * serial and slow — ~1–3 messages/second across the whole fleet — so the
 * per-second rate was low, but *every single replayed message* produced an
 * immediate `busy` push and re-armed `engaged` digest batches for hours.
 * Every message in the run was pushed regardless of its true age.
 *
 * The gate keys on the **canonical message timestamp** —
 * `canonicalMessageTimestamp` (see `materialization/sortIdx.ts`), which
 * honours `timestampOverride` for bridged messages — never the event ULID.
 * That is the only time value that distinguishes "old message, ingested
 * now" from "new message".
 *
 * Undecodable ULIDs fall back to "fresh": this is an *age* check, so a job
 * whose age cannot be determined must not be dropped — silently losing live
 * notifications is the opposite failure and a worse one. An undecodable
 * event id is not a replay signature.
 *
 * @see docs/push-freshness-gate.md for the incident write-up and evidence.
 */

import { decodeTime } from "ulidx";

/**
 * How old a message may be and still produce a push.
 *
 * Justification: this window absorbs clock skew and pipeline latency between
 * a user hitting send and the message reaching this process — it does not
 * batch anything. The live path measures 0–28s end-to-end in production
 * (TASK-151 Loki evidence), so 5 minutes is ~10x the observed worst case and
 * cannot clip a genuine live message.
 *
 * A replay of historical content is hours-to-days old, so no plausible value
 * of this constant would let the 2026-09-16 flood through; the window is
 * chosen for operator headroom, not for the flood's shape.
 */
export const PUSH_MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

/**
 * How long a pending digest batch may sit before the sweep drops it instead
 * of firing it.
 *
 * A digest answers "you missed something while you were away" — that question
 * is answerable for a while, then the batch is simply history. 24h is wide
 * enough to cover a normal overnight absence (the case digests exist for) and
 * far narrower than the rows that accumulated across the 2026-09-16 replay.
 *
 * The sweep's 1h `DIGEST_WINDOW_MS` still governs *when* a fresh batch fires;
 * this constant only decides when a batch is too old to be worth firing at
 * all, which is what makes the sweep safe to run on every restart.
 */
export const PUSH_MAX_DIGEST_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when a message is fresh enough to notify about.
 *
 * A timestamp further in the future than the skew window is treated as
 * stale: a message cannot be "newer than now", so such a row is corrupt
 * rather than live.
 *
 * `now` is injectable for deterministic tests.
 */
export function isPushFresh(
  job: { canonicalTimestamp?: number; messageId: string },
  now: number = Date.now(),
): boolean {
  let timestamp: number;
  if (typeof job.canonicalTimestamp === "number" && Number.isFinite(job.canonicalTimestamp)) {
    timestamp = job.canonicalTimestamp;
  } else {
    try {
      timestamp = decodeTime(job.messageId);
    } catch {
      return true; // age unknown → do not drop a potential live notification
    }
  }
  const age = now - timestamp;
  return age <= PUSH_MAX_MESSAGE_AGE_MS && age >= -PUSH_MAX_MESSAGE_AGE_MS;
}
