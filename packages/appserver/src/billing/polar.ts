/**
 * Polar billing configuration + customer-state client.
 *
 * Roomy Pro subscriptions are billed via polar.sh. A Pro subscriber (or a
 * negotiated custom-membership grant) holds a "bridge token" they can grant
 * to a space; a guild-space bridge spends the token up to
 * `maxMembers(space)` (the sum of valid grant capacities).
 *
 * Reads the customer state endpoint:
 *
 *   GET {endpoint}/customers/external/{external_id}/state
 *
 * with `Authorization: Bearer <organization access token>` (scope
 * `customers:read`). `external_id` is the Roomy user DID. A 404 means the
 * customer does not exist — a valid "capacity 0" answer, NOT an error.
 *
 * The Roomy Pro members-role reconcile sweep additionally needs the
 * organization token to enumerate live subscribers via the subscriptions
 * list endpoint:
 *
 *   GET {endpoint}/subscriptions/?product_id={ROOMY_PRO_PRODUCT_ID}
 *
 * which requires the `subscriptions:read` scope (separate from
 * `customers:read` / `checkouts:write`). A token without it receives 403
 * and the sweep aborts with no writes rather than guessing a user set.
 *
 * Response shape (typed in `PolarCustomerState`):
 *   - active_subscriptions[].status        (active | trialing)
 *   - active_subscriptions[].current_period_end
 *   - active_subscriptions[].product_id    (Roomy Pro product → 1000)
 *   - active_subscriptions[].cancel_at_period_end
 *   - granted_benefits[].benefit_type      (feature_flag grants may carry
 *                                           `benefit_metadata.max_members`)
 *   - granted_benefits[].benefit_metadata  (string|int|float|bool key-values)
 *
 * Capacity per grant (see `resolveCapacity`):
 *   - an active/trialing subscription to the Roomy Pro product → 1000
 *   - a feature_flag benefit carryng `benefit_metadata.max_members` → that
 *     value (negotiated custom memberships)
 *   - multiple valid states → the max
 *   - no valid state → 0
 *
 * Failure semantics are FAIL-OPEN: a Polar outage / 5xx / timeout serves the
 * last-known-valid cached state with a `stale` flag. An unknown state is
 * NEVER treated as capacity 0 — that would wrongly zero out a paying
 * member's capacity. A 404 (customer genuinely absent) IS a definitive
 * capacity 0 and is cached as such.
 *
 * This module is also the process-wide config singleton — set once during
 * `createAppserver`, then read by handlers that don't receive it via
 * constructor injection. Mirrors the `src/happyview.ts` config-singleton
 * pattern. When Polar is not configured (no `POLAR_ACCESS_TOKEN`), the
 * provider is disabled and the bridge-token endpoints reject with 503.
 */

import { log } from "../log.ts";

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Configuration for connecting to the Polar API.
 *
 * Env vars:
 * - `POLAR_ACCESS_TOKEN` — Organization Access Token (`polar_oat_…`, scope
 *   `customers:read`, `checkouts:write`). Required to enable the provider.
 * - `POLAR_ENDPOINT` — API base URL. Defaults to `https://api.polar.sh/v1`;
 *   tests point at the sandbox (`https://sandbox-api.polar.sh/v1`).
 * - `ROOMY_PRO_PRODUCT_ID` — the Polar product ID of the Roomy Pro
 *   subscription (a subscription to it grants 1000 capacity).
 * - `ROOMY_APP_ORIGIN` — public origin of the Roomy app; Polar checkout
 *   sessions redirect the customer back here after payment (with
 *   `?checkout={CHECKOUT_ID}`). Defaults to `https://roomy.space`.
 */
export interface PolarConfig {
  /** API base URL (no trailing slash). */
  endpoint: string;
  /** Organization Access Token (`polar_oat_…`). */
  accessToken: string;
  /** Polar product ID for the Roomy Pro subscription. */
  roomyProProductId: string;
  /** Public origin of the Roomy app (checkout success_url target). */
  appOrigin: string;
}

/**
 * Parse Polar configuration from environment variables. Returns `null`
 * when `POLAR_ACCESS_TOKEN` is unset or `ROOMY_PRO_PRODUCT_ID` is missing —
 * callers treat the provider as disabled.
 */
export function getPolarConfig(): PolarConfig | null {
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  const roomyProProductId = process.env.ROOMY_PRO_PRODUCT_ID;
  if (!accessToken || !roomyProProductId) return null;
  const endpoint =
    process.env.POLAR_ENDPOINT ?? "https://api.polar.sh/v1";
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    accessToken,
    roomyProProductId,
    appOrigin: (process.env.ROOMY_APP_ORIGIN ?? "https://roomy.space").replace(/\/+$/, ""),
  };
}

// ─── Process-wide singleton ───────────────────────────────────────────────

let instance: PolarConfig | null | undefined;

/**
 * Initialize the Polar config singleton from env vars.
 * Called once during `createAppserver`.
 */
export function initPolar(): PolarConfig | null {
  instance = getPolarConfig();
  return instance;
}

/**
 * Explicitly set the Polar config (tests).
 */
export function setPolar(config: PolarConfig | null): void {
  instance = config;
}

/**
 * Get the process-wide Polar config, or `null` if not configured.
 * Returns `null` if `initPolar` hasn't been called yet.
 */
export function getPolar(): PolarConfig | null {
  if (instance === undefined) return null;
  return instance;
}

// ─── Typed customer state ─────────────────────────────────────────────────

/**
 * A single active subscription, as returned by the Polar customer-state
 * endpoint. Only the fields the appserver reads are typed.
 */
export interface PolarActiveSubscription {
  status: "active" | "trialing";
  current_period_end?: string | null;
  product_id: string;
  cancel_at_period_end?: boolean;
}

/** A granted benefit on the customer, as returned by Polar. */
export interface PolarGrantedBenefit {
  benefit_type?: string;
  benefit_metadata?: Record<string, string | number | boolean>;
}

/**
 * Typed response of `GET /customers/external/{external_id}/state`.
 */
export interface PolarCustomerState {
  active_subscriptions: PolarActiveSubscription[];
  granted_benefits: PolarGrantedBenefit[];
}

/** Parse guard: narrows an unknown JSON body to a PolarCustomerState. */
function isPolarCustomerState(v: unknown): v is PolarCustomerState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    Array.isArray(s.active_subscriptions) &&
    Array.isArray(s.granted_benefits)
  );
}

// ─── Capacity resolution ──────────────────────────────────────────────────

/** Default capacity granted by a Roomy Pro subscription. */
export const ROOMY_PRO_CAPACITY = 1000;

/** How a grant's total capacity is derived from a Polar customer state. */
export interface ResolvedCapacity {
  /** The capacity derived from the state, or 0 when nothing valid. */
  capacity: number;
  /** Whether the state was served from the last-known cache (Polar outage). */
  stale: boolean;
}

/**
 * Resolve the bridge-token capacity from a Polar customer state.
 *
 * Capacity rules:
 *   - a subscription to the Roomy Pro product with status active|trialing
 *     → 1000
 *   - a feature_flag benefit carrying `benefit_metadata.max_members` → that
 *     value (negotiated custom memberships; ints and numeric strings both
 *     accepted)
 *   - multiple valid states → max wins
 *   - no valid state → capacity 0
 */
export function resolveCapacity(
  state: PolarCustomerState,
  config: PolarConfig,
): ResolvedCapacity {
  const { roomyProProductId } = config;
  let capacity = 0;

  for (const sub of state.active_subscriptions) {
    if (
      sub.product_id === roomyProProductId &&
      (sub.status === "active" || sub.status === "trialing")
    ) {
      capacity = Math.max(capacity, ROOMY_PRO_CAPACITY);
    }
  }

  for (const benefit of state.granted_benefits) {
    if (benefit.benefit_type !== "feature_flag") continue;
    const raw = benefit.benefit_metadata?.max_members;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "boolean") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) {
      capacity = Math.max(capacity, Math.floor(n));
    }
  }

  return { capacity, stale: false };
}

// ─── Cached client ────────────────────────────────────────────────────────

/** TTL for the per-grantor cache (300s). */
export const POLAR_CACHE_TTL_MS = 300_000;

/** Request timeout for a Polar fetch (10s). */
const POLAR_FETCH_TIMEOUT_MS = 10_000;

/**
 * A resolved cached state for one grantor DID.
 * `state === null` means "definitively no customer" (a cached 404) — a
 * valid capacity-0 answer that must NOT be replaced by a fresh 5xx.
 */
interface CacheEntry {
  state: PolarCustomerState | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: clear the customer-state cache. */
export function _clearPolarCache(): void {
  cache.clear();
}

/**
 * Test-only: age a cached entry out so the next read refetches. Needed
 * because the 300s TTL cannot be shortened without clock injection.
 */
export function _expirePolarCache(did: string): void {
  const entry = cache.get(did);
  if (entry) cache.set(did, { ...entry, fetchedAt: 0 });
}

/**
 * Fetch the Polar customer state for `external_id` (the Roomy user DID).
 *
 * Returns `null` for a 404 (customer does not exist — definitive capacity
 * 0). Throws `PolarUnavailableError` on network failure, non-200 status, or
 * an unparseable response body — callers fail open by falling back to the
 * cache.
 */
export async function getCustomerState(
  externalId: string,
  config: PolarConfig,
): Promise<PolarCustomerState | null> {
  const url = `${config.endpoint}/customers/external/${encodeURIComponent(externalId)}/state`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLAR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new PolarUnavailableError(
        `Polar customer-state returned HTTP ${res.status}`,
      );
    }
    const body: unknown = await res.json();
    if (!isPolarCustomerState(body)) {
      throw new PolarUnavailableError(
        "Polar customer-state response did not match expected shape",
      );
    }
    return body;
  } catch (err) {
    // Network failure, timeout (AbortError), or JSON parse error — any
    // transport-level failure maps to PolarUnavailableError so callers can
    // fail open on the cache. Keep an already-thrown PolarUnavailableError
    // as-is (404 has already returned; non-200 and malformed bodies land
    // here too).
    if (err instanceof PolarUnavailableError) throw err;
    throw new PolarUnavailableError(
      err instanceof Error ? err.message : "Polar customer-state fetch failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a Polar checkout session bound to a customer external ID.
 *
 * Roomy's subscription checks look customers up by external ID == user DID
 * (`GET /customers/external/{external_id}/state`). The only way that
 * external ID gets set is by passing it as `external_customer_id` when the
 * session is created (Checkout API, scope `checkouts:write`): on successful
 * payment Polar creates the customer with that external ID. A static
 * Checkout Link cannot carry an external ID, so the appserver must create
 * every session.
 *
 * Returns the `url` the client should redirect the browser to (the
 * Polar-hosted checkout page). The `success_url` carries
 * `checkout_id={CHECKOUT_ID}`, which Polar substitutes at redirect time —
 * that's what the subscription page's `?checkout=` param reads.
 *
 * Throws `PolarUnavailableError` on transport errors / non-2xx / malformed
 * response — the same fail-open contract as `getCustomerState`.
 */
export interface PolarCheckoutSession {
  id: string;
  url: string;
}

export async function createCheckoutSession(
  config: PolarConfig,
  opts: {
    /** Roomy user DID — becomes the customer's external_id in Polar. */
    externalCustomerId: string;
    /** URL Polar redirects to after payment; `{CHECKOUT_ID}` is substituted. */
    successUrl: string;
    /** Polar product id to sell (defaults to the Roomy Pro product). */
    productId?: string;
  },
): Promise<PolarCheckoutSession> {
  const url = `${config.endpoint}/checkouts/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLAR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        products: [opts.productId ?? config.roomyProProductId],
        external_customer_id: opts.externalCustomerId,
        success_url: opts.successUrl,
      }),
      signal: controller.signal,
    });
    if (res.status !== 201) {
      throw new PolarUnavailableError(
        `Polar checkout-session creation returned HTTP ${res.status}`,
      );
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("id" in body) ||
      !("url" in body) ||
      typeof body.id !== "string" ||
      typeof body.url !== "string"
    ) {
      throw new PolarUnavailableError(
        "Polar checkout-session response did not match expected shape",
      );
    }
    return { id: body.id, url: body.url };
  } catch (err) {
    if (err instanceof PolarUnavailableError) throw err;
    throw new PolarUnavailableError(
      err instanceof Error ? err.message : "Polar checkout-session creation failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List live Roomy Pro subscribers across the whole organization.
 *
 * Used by the Roomy Pro members-area reconcile sweep to compute the desired
 * set of DIDs that should hold the 'Members' role in the Roomy Space.
 *
 * Calls the Polar subscriptions list endpoint:
 *
 *   GET {endpoint}/subscriptions/?product_id={ROOMY_PRO_PRODUCT_ID}
 *
 * filtered to the Roomy Pro product, with the organization access token.
 * NOTE: this endpoint requires the `subscriptions:read` scope on the token,
 * which is separate from `customers:read` / `checkouts:write`. If the token
 * lacks it, Polar returns 403 and this throws `PolarUnavailableError` — the
 * caller must not fall back to guessing a user set (see the sweep module).
 *
 * Pagination mirrors Polar's `page`/`limit` window model (limit max 100).
 * We request the Roomy Pro product filter so the response only contains
 * subscriptions relevant to the members role.
 *
 * Returns the set of `external_id`s (Roomy DID — the customer external ID)
 * whose current subscription status is one of `active` / `trialing`
 * (the live, paying states the appserver already treats as Pro).
 *
 * Fail-safe semantics (match the customer-state client): a non-2xx status,
 * network failure, or malformed body throws `PolarUnavailableError` — the
 * sweep must never interpret an unreachable/malformed Polar as "no one is
 * paying" and mass-remove grants.
 */
export interface PolarSubscriptionItem {
  status: string;
  product_id?: string;
  /** Expanded customer — carries the external_id (Roomy DID). */
  customer?: { external_id?: string | null } | null;
}

function isPolarSubscriptionList(
  v: unknown,
): v is { items: PolarSubscriptionItem[] } {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.items);
}

export const POLAR_SUBSCRIPTIONS_PAGE_SIZE = 100;
export const MAX_SUBSCRIPTION_PAGES = 10;

export async function listProSubscribers(
  config: PolarConfig,
): Promise<Set<string>> {
  const subscribers = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const url =
      `${config.endpoint}/subscriptions/` +
      `?product_id=${encodeURIComponent(config.roomyProProductId)}` +
      `&limit=${POLAR_SUBSCRIPTIONS_PAGE_SIZE}&page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      POLAR_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (res.status !== 200) {
        throw new PolarUnavailableError(
          `Polar subscriptions list returned HTTP ${res.status}`,
        );
      }
      const body: unknown = await res.json();
      if (!isPolarSubscriptionList(body)) {
        throw new PolarUnavailableError(
          "Polar subscriptions list response did not match expected shape",
        );
      }
      for (const item of body.items) {
        const status = item.status;
        if (status !== "active" && status !== "trialing") continue;
        const externalId = item.customer?.external_id;
        if (externalId && externalId.length > 0) {
          subscribers.add(externalId);
        }
      }
      let newTotalPages = 1;
      if ("pagination" in body && typeof body.pagination === "object" && body.pagination !== null) {
        const pagination = body.pagination as Record<string, unknown>;
        if (typeof pagination.max_page === "number") {
          newTotalPages = pagination.max_page;
        }
      }
      // Defensive cap so a malformed `max_page` can't drive an unbounded
      // loop against the Polar API.
      if (newTotalPages > MAX_SUBSCRIPTION_PAGES || newTotalPages < 1) {
        newTotalPages = 1;
      }
      totalPages = newTotalPages;
      page += 1;
    } catch (err) {
      if (err instanceof PolarUnavailableError) throw err;
      throw new PolarUnavailableError(
        err instanceof Error
          ? err.message
          : "Polar subscriptions list fetch failed",
      );
    } finally {
      clearTimeout(timer);
    }
  } while (page <= totalPages);
  return subscribers;
}

/**
 * Error thrown when the Polar API is unavailable or malformed. Not a "no
 * customer" — callers must fail open (serve cached state) rather than
 * treating it as capacity 0.
 */
export class PolarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarUnavailableError";
  }
}

/**
 * Read the current Polar state for `externalId`, caching it per grantor for
 * 300s.
 *
 * Fail-open semantics:
 *   - TTL fresh → cached state (no network).
 *   - TTL stale → refresh; on success return fresh state and replace the
 *     cache. On failure serve the last-known-valid cached state with
 *     `stale: true`. A 404 (no customer) IS valid and replaces the cache.
 *   - Nothing cached yet + fetch fails → throw `PolarUnavailableError`
 *     (there is no last-known state to serve; the caller decides).
 *
 * `stale` in the result is `true` exactly when the served state came from
 * the cache because a refresh failed.
 *
 * `force: true` bypasses the TTL and always refetches (used by the
 * subscription-status endpoint after a Polar checkout redirect, so the
 * user sees their new membership immediately instead of up to 300s of
 * cached "not a member"). On refresh failure the cached state is still
 * served with `stale: true` — fail-open applies to forced reads too.
 */
export async function getCachedCustomerState(
  externalId: string,
  config: PolarConfig,
  opts: { force?: boolean } = {},
): Promise<{ state: PolarCustomerState | null; stale: boolean }> {
  const now = Date.now();
  const cached = cache.get(externalId);

  if (!opts.force && cached && now - cached.fetchedAt < POLAR_CACHE_TTL_MS) {
    return { state: cached.state, stale: false };
  }

  try {
    const state = await getCustomerState(externalId, config);
    cache.set(externalId, { state, fetchedAt: Date.now() });
    return { state, stale: false };
  } catch (err) {
    log.warn(
      "[polar] customer-state fetch failed; serving cached state",
      err instanceof Error ? err : undefined,
    );
    if (cached) {
      return { state: cached.state, stale: true };
    }
    throw err;
  }
}
