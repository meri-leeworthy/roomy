import { dev } from "$app/environment";
import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { ZoneContextManager } from "@opentelemetry/context-zone";

import { getWebInstrumentations, initializeFaro } from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";

if (dev && window.location.hostname == "localhost")
  window.location.hostname = "127.0.0.1";

// For now, unregister the service worker, in case it might be causing problems.
window.navigator.serviceWorker.getRegistrations().then((registrations) => {
  let hadRegistration = false;
  for (const registration of registrations) {
    hadRegistration = true;
    registration.unregister();
  }
  // Reload the page just to make sure things are totally reset.
  if (hadRegistration) window.location.reload();
});

initializeFaro({
  url: "http://localhost:12345/collect",
  apiKey: "bad_api_key",
  app: {
    name: "roomy",
    version: "0.1.0-alpha-7",
  },
  instrumentations: [
    ...getWebInstrumentations(),
    new TracingInstrumentation({
      contextManager: new ZoneContextManager(),
      instrumentations: [new DocumentLoadInstrumentation()],
    }),
  ],
});

window.faro.api
  .getOTEL()!
  .trace.getTracer("frontend")
  .startActiveSpan("hello world", (span) => {
    // send a log message
    window.faro.api.pushLog(["hello world"]);
    span.end();
  });

export const handleError: HandleClientError = async ({
  error,
  event,
  status,
  message,
}) => {
  window.faro.api.pushError({
    message: `message=${message} status=${status} ${Object.entries(event.params)
      .map(([k, v]) => `params.${k}=${v}`)
      .join(" ")} url=${event.url} route.id=${event.route.id}`,
    name: "Svelte client error",
  });

  if (status !== 404) {
    console.error(error, status, event, message);
    posthog.captureException(error, { status, event, message });
  }
};
