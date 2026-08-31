import {
  ConsoleInstrumentation,
  ErrorsInstrumentation,
  initializeFaro,
  type BrowserConfig,
} from "@grafana/faro-web-sdk";
import { CONFIG } from "$lib/config";

/**
 * Grafana Faro browser agent — client-side log + error collection.
 *
 * Faro pushes console.* output and uncaught errors from the browser to an
 * Alloy `faro.receiver` endpoint (dev: compose.yaml, prod: deploy/alloy),
 * which forwards them to Loki. The app has no server stdout, so this is the
 * only channel for app-lite logs.
 *
 * Disabled by default: without PUBLIC_FARO_URL the agent is never
 * initialized — zero network traffic, zero console noise, zero feature cost.
 * Set PUBLIC_FARO_URL (e.g. http://127.0.0.1:12345 in dev) to enable.
 *
 * Browser-only: initialize from client-side code (see initFaro's guard);
 * Faro never runs during SSR/prerender.
 *
 * v1 scope: console + error instrumentation only. No web vitals, no tracing.
 */

const url = CONFIG.faroUrl;

/**
 * Initializes the Faro agent. No-op when PUBLIC_FARO_URL is unset or when
 * running outside a browser (SSR/prerender/build-time imports).
 *
 * Safe to call more than once: Faro's internal singleton guard prevents
 * duplicate agents; the second call is a no-op.
 */
export function initFaro(): void {
  if (!url) return;
  if (typeof window === "undefined") return;

  // The Alloy faro.receiver serves its API at /collect; the transport POSTs
  // verbatim to the configured URL. Accept both a bare origin and a full URL
  // by defaulting an empty path to /collect (canonical Faro usage).
  const endpoint = new URL(url);
  if (endpoint.pathname === "" || endpoint.pathname === "/") {
    endpoint.pathname = "/collect";
  }

  const config: BrowserConfig = {
    url: endpoint.toString(),
    apiKey: CONFIG.faroApiKey ?? undefined,
    app: {
      name: "app-lite",
      version: __BUILD_ID__ ?? __APP_VERSION__,
    },
    instrumentations: [new ConsoleInstrumentation(), new ErrorsInstrumentation()],
  };

  initializeFaro(config);
}
