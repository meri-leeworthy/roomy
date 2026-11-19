/**
 * What a dead session costs the query layer, against a real `QueryClient`.
 *
 * The rules themselves are one-liners over `session-health.ts`'s marks; what
 * this pins is that TanStack actually asks them, at the three points it spends a
 * request (`retry`, `retryOnMount`, `refetchOnMount`), with the defaults the app
 * installs (`QUERY_DEFAULTS`). The client assembled here differs from
 * `client.ts`'s in one way: its `onError` does not also call
 * `scheduleAutoReload`, because a test run must not schedule reloads.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import {
  QueryCache,
  QueryClient,
  QueryObserver,
  environmentManager,
} from "@tanstack/svelte-query";

import { QUERY_DEFAULTS } from "./query-policy";
import {
  clearSessionTerminals,
  createSessionAwareFetch,
  markSessionTerminal,
} from "./session-health";

const SESSION_ORIGIN = "https://hv.example.test";
const QUERY_KEY = ["space.roomy.space.getSpaces", { spaceId: "space" }] as const;

/** The shape `@atproto/xrpc` throws for a rejected request: a status, no NSID. */
function sessionRejection(status = 401): Error {
  return Object.assign(new Error(`session answered ${status}`), { status });
}

// TanStack's own default retry count is 3 in a browser and 0 under a server
// runtime, and a test runner looks like the latter. These rules are the
// browser's — the client under test is one — so say so, and let the retry cases
// measure what the app actually does.
environmentManager.setIsServer(() => false);

function queryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => markSessionTerminal(err, query.queryHash),
      onSuccess: () => clearSessionTerminals(),
    }),
    // `retryDelay: 0` so the retry cases finish without waiting out TanStack's
    // 1s/2s backoff; the retry *decision* is what is under test.
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retryDelay: 0 } },
  });
}

/**
 * Mount a query the way a component does — a new observer taking its first
 * listener is TanStack's mount — and wait for whatever it decided to do.
 *
 * A mount that spends a request finishes in the next few tasks (retries are
 * zero-delay here); a mount that spends none is only distinguishable from one
 * that has not started yet by waiting for the count to stop moving. Both are
 * covered by requiring the request count and the fetch status to be unchanged
 * for several consecutive ticks.
 */
async function mount(
  client: QueryClient,
  options: { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; staleTime?: number },
  requests: string[],
): Promise<QueryObserver<unknown, Error>> {
  const observer = new QueryObserver<unknown, Error>(client, options);
  const unsubscribe = observer.subscribe(() => {});

  let lastCount = -1;
  let quietTicks = 0;
  for (let tick = 0; tick < 500 && quietTicks < 5; tick += 1) {
    const settled =
      observer.getCurrentResult().fetchStatus === "idle" &&
      requests.length === lastCount;
    quietTicks = settled ? quietTicks + 1 : 0;
    lastCount = requests.length;
    await sleep(2);
  }

  unsubscribe();
  return observer;
}

describe("a session-origin 401 in the query layer", () => {
  beforeEach(() => {
    clearSessionTerminals();
  });

  it("is spent once per key: it is not retried, and a remount does not ask again", async () => {
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("get");
        throw sessionRejection();
      },
    };

    await mount(client, options, requests);
    expect(requests).toHaveLength(1);
    expect(client.getQueryCache().find({ queryKey: QUERY_KEY })?.state.status).toBe("error");

    await mount(client, options, requests);
    expect(requests).toHaveLength(1);
  });

  it("stops a stale view reloading itself from the persisted cache", async () => {
    let answer: "data" | "rejected" = "data";
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      queryKey: QUERY_KEY,
      // The `staleTime: 0` views (`getActivityFeed`, `getSpaces`) revalidate on
      // every mount while they hold data — the case a dead session turns into
      // one rejected request per remount.
      staleTime: 0,
      queryFn: async () => {
        requests.push(answer);
        if (answer === "rejected") throw sessionRejection();
        return { spaces: [] };
      },
    };

    await mount(client, options, requests);
    expect(requests).toHaveLength(1);

    // The session died behind the view: the revalidation on the next mount is
    // rejected, which is the one request that key gets.
    answer = "rejected";
    await mount(client, options, requests);
    expect(requests).toHaveLength(2);
    expect(client.getQueryCache().find({ queryKey: QUERY_KEY })?.state.data).toEqual({
      spaces: [],
    });

    await mount(client, options, requests);
    expect(requests).toHaveLength(2);
  });

  it("keeps retrying a 5xx", async () => {
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("get");
        throw Object.assign(new Error("upstream is unwell"), { status: 503 });
      },
    };

    await mount(client, options, requests);
    // One request plus the three retries TanStack's default `retry: 3` allows.
    expect(requests).toHaveLength(4);
  });

  it("keeps retrying a request that never got a response", async () => {
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("get");
        throw Object.assign(new TypeError("Failed to fetch"), { status: 0 });
      },
    };

    await mount(client, options, requests);
    expect(requests).toHaveLength(4);
  });

  it("re-enables the key when the session answers an accepted request", async () => {
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("get");
        if (requests.length === 1) throw sessionRejection();
        return { spaces: [] };
      },
    };

    await mount(client, options, requests);
    expect(requests).toHaveLength(1);
    await mount(client, options, requests);
    expect(requests).toHaveLength(1);

    // The session changed: the wrapped fetch saw a response the session origin
    // accepted (a token refresh, a restore) — that is the signal the key was
    // waiting for.
    const sessionFetch = createSessionAwareFetch({
      origin: SESSION_ORIGIN,
      fetch: async () => new Response("{}", { status: 200 }),
      storage: null,
      onExhausted: () => {},
    });
    await sessionFetch(`${SESSION_ORIGIN}/oauth/token`, { method: "POST" });

    await mount(client, options, requests);
    expect(requests).toHaveLength(2);
    expect(client.getQueryCache().find({ queryKey: QUERY_KEY })?.state.data).toEqual({
      spaces: [],
    });
  });

  it("leaves an appserver 401 alone (per-resource authorization, not a dead session)", async () => {
    const requests: string[] = [];
    const client = queryClient();
    const options = {
      // The query's own `retry: false` keeps a deterministic 403/404 to one
      // request; a session rejection is stopped by the shared policy instead.
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("get");
        throw Object.assign(new Error("XRPC failed (401)"), {
          status: 401,
          nsid: QUERY_KEY[0],
        });
      },
    };

    await mount(client, options, requests);
    expect(requests).toHaveLength(4);
  });

  it("re-enables a key when another query proves the session works", async () => {
    // Every appserver call mints a service-auth token from the session first,
    // so a query that completed is a session request that was answered — the
    // second way back in, and the only one that needs no HappyView origin.
    const requests: string[] = [];
    const client = queryClient();
    const rejected = {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        requests.push("rejected");
        throw sessionRejection();
      },
    };
    const answered = {
      queryKey: ["space.roomy.space.getMetadata", { spaceId: "space" }] as const,
      queryFn: async () => {
        requests.push("answered");
        return { name: "space" };
      },
    };

    await mount(client, rejected, requests);
    await mount(client, rejected, requests);
    expect(requests).toEqual(["rejected"]);

    await mount(client, answered, requests);
    expect(requests).toEqual(["rejected", "answered"]);

    await mount(client, rejected, requests);
    expect(requests).toEqual(["rejected", "answered", "rejected"]);
  });
});
