/**
 * `fetch` with a hard abort deadline, for the outbound third-party profile
 * calls (HappyView, the Bluesky appview, a user's PDS).
 *
 * `fetch` imposes no timeout of its own: under Bun a server that accepts the
 * connection and then never responds leaves the promise pending forever
 * (verified), so an unbounded call parks whatever awaits it for as long as the
 * peer stays silent. On the profile paths the awaiter is a user request, which
 * is how a hung HappyView turned into requests that never returned.
 *
 * `AbortSignal.timeout` bounds the response *and* the body read — an abort
 * mid-body rejects `res.json()`/`res.text()` — and its timer does not hold the
 * process open, which is why this uses it rather than a manual
 * `setTimeout(() => controller.abort(), ms)`.
 */

/** Env override, read per call so tests can drive a short deadline. */
const DEFAULT_PROFILE_FETCH_TIMEOUT_MS = 3000;

/**
 * Deadline for one profile fetch. Profile display fields are a cosmetic
 * enhancement, so a slow source degrades to whatever the global `profiles` row
 * already holds — it must never hold a request open. Tunable via
 * `PROFILE_FETCH_TIMEOUT_MS`; mirrors `EMBED_METADATA_TIMEOUT_MS` in
 * `embed/metadata.ts`.
 */
export function profileFetchTimeoutMs(): number {
  const raw = Number(process.env.PROFILE_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROFILE_FETCH_TIMEOUT_MS;
}

/**
 * `fetch` that always aborts after `timeoutMs` (default:
 * {@link profileFetchTimeoutMs}). A caller-supplied `init.signal` is
 * preserved: the request aborts on whichever comes first, the deadline or the
 * caller's signal.
 */
export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = profileFetchTimeoutMs(),
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  return fetch(input, { ...init, signal });
}
