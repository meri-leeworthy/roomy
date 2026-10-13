import { setBlobOrigin } from "@roomy/design/utils";

/**
 * Cached appserver HTTP origin.
 *
 * Populated during auth init from the appserver's DID document and read
 * synchronously by blob-URL resolution (media elements like `<video>` need
 * a synchronous `src`). The origin is stable for a given deployment.
 *
 * Blob-URL resolution itself lives in `@roomy/design/utils` — it is pure
 * string work that presentational components need — so the origin is handed
 * to the design layer here, the same way the internal-link origins are.
 */

let cachedOrigin: string | null = null;

export function setAppserverOrigin(origin: string): void {
  cachedOrigin = origin.replace(/\/+$/, "");
  setBlobOrigin(cachedOrigin);
}

export function getAppserverOrigin(): string | null {
  return cachedOrigin;
}
