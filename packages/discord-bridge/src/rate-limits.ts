/**
 * Provenance for the HTTP 429s the bridge observes.
 *
 * A 429 can be answered by the appserver, by Cloudflare, or by Railway's edge
 * in front of it, and the response headers name the layer. The SDK captures
 * them on `RateLimitError.rejection`; this module labels the layer once, keeps
 * per-layer counts for `GET /rate-limits`, and hands the log paths a stable
 * set of fields so a burst is readable without a log hunt.
 */

import { transport } from "@roomy-space/sdk";

export type RateLimitLayer = "cloudflare" | "railway" | "edge" | "unknown";

/** What a 429 log line carries: the layer label plus the headers behind it. */
export interface RateLimitFields {
	layer: RateLimitLayer;
	host: string | null;
	nsid: string | null;
	cfRay: string | null;
	server: string | null;
}

/** The most recent rejection, as `GET /rate-limits` reports it. */
export interface RateLimitObservation {
	/** ISO-8601 time the rejection was observed. */
	at: string;
	host: string | null;
	nsid: string | null;
	layer: RateLimitLayer;
	cfRay: string | null;
}

export interface RateLimitSnapshot {
	byLayer: Record<RateLimitLayer, number>;
	last: RateLimitObservation | null;
}

const LAYERS: readonly RateLimitLayer[] = [
	"cloudflare",
	"railway",
	"edge",
	"unknown",
];

const byLayer: Record<RateLimitLayer, number> = {
	cloudflare: 0,
	railway: 0,
	edge: 0,
	unknown: 0,
};

let last: RateLimitObservation | null = null;

/**
 * Label a 429 by the layer that answered it, count it, and return the fields
 * to log. Returns null for anything that is not a `RateLimitError`, so callers
 * can use one expression for every failure.
 */
export function observeRateLimit(
	err: unknown,
	nsidHint: string | null = null,
): RateLimitFields | null {
	if (!(err instanceof transport.RateLimitError)) return null;
	const rejection = err.rejection;
	// `toXrpcError` assigns the NSID onto the error it builds; it is not a
	// declared field, so it is read structurally.
	const nsid =
		"nsid" in err && typeof err.nsid === "string" ? err.nsid : nsidHint;
	const fields: RateLimitFields = {
		layer: transport.classifyRateLimitRejection(rejection),
		host: rejection?.host ?? null,
		nsid,
		cfRay: rejection?.cfRay ?? null,
		server: rejection?.server ?? null,
	};
	byLayer[fields.layer]++;
	last = {
		at: new Date().toISOString(),
		host: fields.host,
		nsid: fields.nsid,
		layer: fields.layer,
		cfRay: fields.cfRay,
	};
	return fields;
}

/** Per-layer counts and the most recent rejection; a copy safe to serialize. */
export function getRateLimitSnapshot(): RateLimitSnapshot {
	return { byLayer: { ...byLayer }, last };
}

/** Test seam: clear the counters between cases. */
export function resetRateLimits(): void {
	for (const layer of LAYERS) byLayer[layer] = 0;
	last = null;
}

/** The provenance as a suffix for a stored or logged error message. */
export function formatRateLimit(fields: RateLimitFields): string {
	const parts = [`layer=${fields.layer}`];
	if (fields.host) parts.push(`host=${fields.host}`);
	if (fields.cfRay) parts.push(`cf-ray=${fields.cfRay}`);
	if (fields.server) parts.push(`server=${fields.server}`);
	return `[${parts.join(" ")}]`;
}
