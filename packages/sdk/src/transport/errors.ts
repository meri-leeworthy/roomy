/**
 * Typed error raised when an XRPC response (or request input) fails to parse
 * against its arktype schema. Carries the NSID and the underlying arktype
 * error so callers can surface contract drift between client and appserver.
 */
import type { type } from "arktype";

export class XrpcResponseValidationError extends Error {
  readonly nsid: string;
  readonly arktypeError: type.errors;

  constructor(nsid: string, arktypeError: type.errors) {
    super(
      `XRPC response failed validation for ${nsid}: ${arktypeError.summary}`,
    );
    this.name = "XrpcResponseValidationError";
    this.nsid = nsid;
    this.arktypeError = arktypeError;
  }
}

/**
 * Raised when an XRPC request exceeds its deadline. The request is aborted,
 * so no response (success or error) will arrive for it. Distinct from a
 * server error: the caller may retry the call, but must re-obtain a service
 * auth token first (the token is not consumed by an aborted request).
 */
export class XrpcTimeoutError extends Error {
  readonly nsid: string;
  readonly timeoutMs: number;

  constructor(nsid: string, timeoutMs: number) {
    super(
      `XRPC ${nsid} timed out after ${timeoutMs}ms (request aborted; no response received)`,
    );
    this.name = "XrpcTimeoutError";
    this.nsid = nsid;
    this.timeoutMs = timeoutMs;
  }
}

/** The hop that answered a 429, as far as its response headers say. */
export type RateLimitRejectionLayer =
  | "cloudflare"
  | "railway"
  | "edge"
  | "unknown";

/**
 * Provenance captured from the `Response` that carried a 429: which host was
 * asked, what the rejecting hop called itself, and the start of its body.
 * Each field is null when the response did not carry it.
 */
export interface RateLimitRejection {
  /** Host of the response URL, e.g. `api.roomy.space`. */
  readonly host: string | null;
  /** `server` response header, e.g. `cloudflare` or `railway`. */
  readonly server: string | null;
  /** `cf-ray` response header: set by Cloudflare on every response it serves. */
  readonly cfRay: string | null;
  /** `cf-mitigated` response header: Cloudflare marking its own rejection. */
  readonly cfMitigated: string | null;
  /** Retry-After in seconds, the same value the error carries. */
  readonly retryAfterSec: number | null;
  /** `content-type` response header. */
  readonly contentType: string | null;
  /** First 200 bytes of the body; null when it could not be read. */
  readonly bodyPrefix: string | null;
}

/**
 * Name the layer that answered a 429 from the response's own headers.
 *
 * `cf-ray` is present on every Cloudflare-served response, including the 429
 * it generates itself, so it wins over everything else. `server: railway` is
 * Railway's edge answering before the app server does. `cf-mitigated` or an
 * HTML body is an edge rejection that names no vendor. Anything else — the
 * appserver's own limiter, or a hop that exposes nothing — is `unknown`.
 */
export function classifyRateLimitRejection(
  rejection: RateLimitRejection | null | undefined,
): RateLimitRejectionLayer {
  if (!rejection) return "unknown";
  if (rejection.cfRay) return "cloudflare";
  if (rejection.server?.toLowerCase().includes("railway")) return "railway";
  const body = rejection.bodyPrefix?.trimStart() ?? "";
  if (
    rejection.cfMitigated ||
    rejection.contentType?.toLowerCase().includes("text/html") ||
    body.startsWith("<")
  ) {
    return "edge";
  }
  return "unknown";
}

/**
 * Raised when the server returns an HTTP 429 (Too Many Requests) response.
 * Carries the `Retry-After` header value (in seconds) when available, and the
 * provenance of the response that rejected the request.
 */
export class RateLimitError extends Error {
  /** HTTP status code (always 429). */
  readonly status = 429;
  /** Retry-After value in seconds, if the server provided one. */
  readonly retryAfterSec: number | null;
  /** The rejecting hop's own headers, or null when not built from a Response. */
  readonly rejection: RateLimitRejection | null;

  constructor(
    retryAfterSec: number | null,
    message?: string,
    rejection: RateLimitRejection | null = null,
  ) {
    super(message ?? "Rate limited by server (429)");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
    this.rejection = rejection;
  }
}

/**
 * Raised when a proxied XRPC operation through the arbiter fails.
 *
 * The arbiter relays the upstream (stewarded PDS) XRPC error response
 * verbatim: HTTP status + a JSON body `{ $type, error: "<name>" }`. This
 * surfaces that error name (e.g. `HandleNotAvailable`, `InvalidHandle`,
 * `InvalidPassword`) so callers can map it to a friendly message.
 */
export class ArbiterProxyError extends Error {
  /** HTTP status of the upstream XRPC error. */
  readonly status: number;
  /** The upstream XRPC error name (e.g. `HandleNotAvailable`), if present. */
  readonly errorName: string | null;

  constructor(status: number, message: string, errorName: string | null) {
    super(message);
    this.name = "ArbiterProxyError";
    this.status = status;
    this.errorName = errorName;
  }
}

/**
 * Check if an error is (or wraps) an HTTP 429 / rate-limit response.
 * Walks the error chain and checks `status`, `statusCode`, and message content.
 */
export function isRateLimitError(
  err: unknown,
): err is RateLimitError & { status: 429 } {
  if (err instanceof RateLimitError) return true;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.status === 429 || e.statusCode === 429) return true;
    // @atproto/xrpc throws objects with a `status` field
    if (typeof e.message === "string" && e.message.includes("429")) return true;
  }
  return false;
}

/**
 * Extract a Retry-After value (ms) from an error, if available.
 * Returns `null` if no Retry-After information is found and the error is
 * not a rate-limit error; returns `defaultMs` when the error *is* a
 * rate-limit error but carries no explicit Retry-After.
 *
 * Handles two header shapes:
 *  - `Headers` (WHATWG) — from `DirectXrpcClient`'s `RateLimitError` and
 *    raw `fetch` responses; accessed via `.get("retry-after")`.
 *  - `Record<string, string|undefined>` (`HeadersMap`) — from
 *    `@atproto/xrpc`'s `XRPCError.headers`; accessed by key lookup.
 */
export function getRetryAfterMs(err: unknown, defaultMs = 5000): number | null {
  if (err instanceof RateLimitError && err.retryAfterSec != null) {
    return err.retryAfterSec * 1000;
  }
  if (err && typeof err === "object") {
    const headers = (err as Record<string, unknown>).headers;
    if (headers && typeof headers === "object") {
      const ra = readRetryAfter(headers);
      if (ra !== null) return ra;
    }
  }
  return isRateLimitError(err) ? defaultMs : null;
}

/**
 * Read a positive Retry-After value (in ms) from a headers object, which
 * may be either a WHATWG `Headers` (has a `.get()` method) or a plain
 * `Record<string, string|undefined>` (the `HeadersMap` used by
 * `@atproto/xrpc`). Returns `null` if absent or unparseable.
 */
function readRetryAfter(headers: object): number | null {
  // WHATWG Headers — duck-typed via the get method.
  if ("get" in headers && typeof headers.get === "function") {
    const ra = headers.get("retry-after");
    return parseRetryAfter(ra);
  }
  // Plain HeadersMap record — narrow with `in` before indexing.
  if ("retry-after" in headers) {
    const ra = headers["retry-after"];
    if (typeof ra === "string") return parseRetryAfter(ra);
  }
  return null;
}

function parseRetryAfter(ra: string | null): number | null {
  if (typeof ra !== "string") return null;
  const sec = Number(ra);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}
