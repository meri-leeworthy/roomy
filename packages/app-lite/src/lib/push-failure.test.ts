/**
 * Tests for the login-time push failure rules and the outcome they read.
 *
 * Two questions are load-bearing here. The first: does a failed sign-in
 * re-subscribe reach the caller as a value at all — reducing it to a console
 * line is what left a week of production push failures invisible. The second:
 * does that value produce exactly one notice per failure class, and nothing at
 * all for the outcomes that are expected states (`denied`, `no-key`,
 * `unsupported`), which would otherwise nag a user who blocked notifications
 * on every sign-in.
 *
 * The browser surface `push.svelte.ts` talks to is stubbed through
 * `node:module` resolve hooks (the pattern `telemetry/tile-events.test.ts`
 * uses), so the real subscribe path runs against a fake `pushManager`,
 * `Notification` and XRPC client. Those imports are dynamic on purpose: the
 * hooks must be registered before the module graph is linked.
 *
 * Written against `node:test` + `node:assert` so the file runs under the
 * package's `node --test` runner.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { EventAttributes } from "./telemetry/faro";
import type { PushFailureClass } from "./push-failure";
import type { PushOutcome } from "./push.svelte";
import { readFileSync } from "node:fs";

/** The authenticated XRPC client, as far as the push module uses it. */
interface StubClient {
  query(method: string, params: unknown): Promise<{ publicKey: string }>;
}

interface StubSubscription {
  endpoint: string;
  toJSON(): unknown;
}

/** Browser surface the push module reads, driven by each test. */
interface PushTestEnv {
  client: StubClient;
  nativeSupported: boolean;
  nativeToken: string | null;
  registerNative(token: string): Promise<void>;
  /** `pushManager.subscribe()` result, or a rejection to model a dead service. */
  subscribe(): Promise<StubSubscription>;
  registered: string[];
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/capability-token-for-this-device";

const STUBS: Record<string, string> = {
  "test-stub:navigation": "export function goto() {}",
  "test-stub:auth": "export function px() { return globalThis.__pushEnv().client; }",
  "test-stub:registration": `
    export async function registerPushSubscription(sub) {
      globalThis.__pushEnv().registered.push(sub.endpoint);
    }
    export async function unregisterPushSubscription() {}
  `,
  "test-stub:native": `
    export function nativePushSupported() { return globalThis.__pushEnv().nativeSupported; }
    export function lastNativeToken() { return globalThis.__pushEnv().nativeToken; }
    export function registerNativeToken(token) { return globalThis.__pushEnv().registerNative(token); }
    export async function ensureNativeSubscription() { return { status: "ok" }; }
    export async function clearNativeSubscription() { return { status: "ok" }; }
  `,
};

const RESOLVE: Record<string, string> = {
  "$app/navigation": "test-stub:navigation",
  "$lib/auth.svelte": "test-stub:auth",
  "$lib/mutations/push-subscription": "test-stub:registration",
  "$lib/native-push": "test-stub:native",
};

const PUSH_TS = new URL("./push.svelte.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    const stub = RESOLVE[specifier];
    if (stub !== undefined) return { url: stub, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const source = STUBS[url];
    if (source !== undefined) return { format: "module", shortCircuit: true, source };
    // `.svelte.ts` is not an extension node strips types from on its own.
    if (url === PUSH_TS) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: readFileSync(new URL(url), "utf8"),
      };
    }
    return next(url, context);
  },
});

const { admitPushFailure, pushFailureAttributes, scrubPushDetail, toPushFailure } =
  await import("./push-failure.ts");
const { subscribeIfAlreadyPermitted } = await import(PUSH_TS);

/**
 * The stubbed modules reach state through `globalThis`; node has no such
 * property, so this is the test's own boundary.
 */
const stubbedGlobals = globalThis as unknown as { __pushEnv: () => PushTestEnv };

function useEnv(overrides: Partial<PushTestEnv> & { vapidKey?: string }): PushTestEnv {
  const key = overrides.vapidKey ?? "BOr3nQ4h9Z1k8yXa2mLs6TpVqWc0dEfGhIjKlMnOpQr";
  const env: PushTestEnv = {
    client: { query: async () => ({ publicKey: key }) },
    nativeSupported: overrides.nativeSupported ?? false,
    nativeToken: overrides.nativeToken ?? null,
    registerNative: overrides.registerNative ?? (async () => {}),
    subscribe: overrides.subscribe ?? (async () => ({ endpoint: ENDPOINT, toJSON() {} })),
    registered: [],
  };
  stubbedGlobals.__pushEnv = () => env;
  return env;
}

/** Install the globals `supportsPush()` and `subscribeAndRegister()` read. */
function useBrowser(options: {
  permission?: NotificationPermission;
  subscribe?: () => Promise<StubSubscription>;
  pushManager?: boolean;
}) {
  const subscription: StubSubscription = { endpoint: ENDPOINT, toJSON() {} };
  const registration = {
    // `activeServiceWorker` takes a registration that has one of these.
    active: {},
    pushManager: {
      getSubscription: async () => null,
      subscribe: options.subscribe ?? (async () => subscription),
    },
  };
  const store = new Map<string, string>();
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  define("Notification", { permission: options.permission ?? "granted" });
  define("window", options.pushManager === false ? {} : { PushManager: function () {} });
  define("navigator", { serviceWorker: { getRegistrations: async () => [registration] } });
  define("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

describe("toPushFailure", () => {
  test("counts only a real failure of the subscribe path", () => {
    assert.deepEqual(toPushFailure({ status: "failed", message: "boom" }), {
      status: "failed",
      message: "boom",
    });
    assert.deepEqual(toPushFailure({ status: "timeout" }), { status: "timeout" });
  });

  test("ignores the expected states and an attempt that never happened", () => {
    assert.equal(toPushFailure(null), null);
    assert.equal(toPushFailure({ status: "ok" }), null);
    assert.equal(toPushFailure({ status: "denied" }), null);
    assert.equal(toPushFailure({ status: "no-key" }), null);
    assert.equal(toPushFailure({ status: "unsupported" }), null);
  });
});

describe("scrubPushDetail", () => {
  test("drops a capability endpoint the error message quoted", () => {
    const detail = scrubPushDetail(`register failed for ${ENDPOINT}`);
    assert.ok(!detail.includes("fcm.googleapis.com"));
    assert.ok(!detail.includes("capability-token"));
  });

  test("keeps the error text that names the cause", () => {
    assert.equal(
      scrubPushDetail("AbortError (20): pushManager.subscribe timed out after 20s"),
      "AbortError (20): pushManager.subscribe timed out after 20s",
    );
  });

  test("truncates a long detail rather than shipping a payload", () => {
    assert.ok(scrubPushDetail("x".repeat(500)).length <= 201);
  });
});

describe("pushFailureAttributes", () => {
  test("carries the status and the scrubbed detail of a `failed`", () => {
    const attributes = pushFailureAttributes({
      status: "failed",
      message: `AbortError: failed at ${ENDPOINT}`,
    });
    assert.equal(attributes.status, "failed");
    assert.ok(attributes.message !== undefined);
    assert.ok(!attributes.message.includes("https://"));
  });

  test("carries the status alone for a `timeout`, which has no detail", () => {
    assert.deepEqual(pushFailureAttributes({ status: "timeout" }), { status: "timeout" });
  });
});

describe("admitPushFailure", () => {
  test("lets the first failure of a class through and repeats nothing", () => {
    const admitted = new Set<PushFailureClass>();
    assert.equal(admitPushFailure({ status: "failed", message: "a" }, admitted), true);
    assert.equal(admitPushFailure({ status: "failed", message: "b" }, admitted), false);
    assert.equal(admitPushFailure({ status: "timeout" }, admitted), true);
    assert.equal(admitPushFailure({ status: "timeout" }, admitted), false);
  });
});

/**
 * The rule `push-notice.svelte.ts` applies on every sign-in, composed here the
 * way the store composes it: count each real failure, raise at most one notice
 * per class.
 */
describe("a session of login-time outcomes", () => {
  test("counts every real failure but raises one notice per class", () => {
    const outcomes: PushOutcome[] = [
      { status: "ok" },
      { status: "unsupported" },
      { status: "denied" },
      { status: "no-key" },
      { status: "timeout" },
      { status: "failed", message: "Registration failed - push service error" },
      { status: "failed", message: "TypeError: Failed to fetch" },
      { status: "timeout" },
    ];

    const counted: EventAttributes[] = [];
    const admitted = new Set<PushFailureClass>();
    const raised: PushFailureClass[] = [];
    for (const outcome of outcomes) {
      const failure = toPushFailure(outcome);
      if (failure === null) continue;
      counted.push(pushFailureAttributes(failure));
      if (admitPushFailure(failure, admitted)) raised.push(failure.status);
    }

    // One event per failure, so the class is countable however often it recurs.
    assert.deepEqual(
      counted.map((attributes) => attributes.status),
      ["timeout", "failed", "failed", "timeout"],
    );
    // One notice per class, so a push service that fails on every sign-in does
    // not nag.
    assert.deepEqual(raised, ["timeout", "failed"]);
  });
});

describe("subscribeIfAlreadyPermitted", () => {
  // The subscribe path races `pushManager.subscribe()` against a 20 s
  // deadline, and that timer outlives a settled attempt. Mocking timers keeps
  // the run from waiting it out.
  test("returns the outcome `subscribeAndRegister` produced and registers it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = useEnv({});
    useBrowser({});

    assert.deepEqual(await subscribeIfAlreadyPermitted(), { status: "ok" });
    assert.deepEqual(env.registered, [ENDPOINT]);
  });

  test("returns `failed` carrying the push service's own message", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    useEnv({});
    useBrowser({
      subscribe: async () => {
        throw new Error("Registration failed - push service error");
      },
    });

    const outcome = await subscribeIfAlreadyPermitted();
    assert.equal(outcome?.status, "failed");
    if (outcome?.status !== "failed") assert.fail("expected a failed outcome");
    assert.match(outcome.message, /push service error/);
  });

  test("returns `no-key` when the appserver has no VAPID key configured", async () => {
    useEnv({ vapidKey: "" });
    useBrowser({});

    assert.deepEqual(await subscribeIfAlreadyPermitted(), { status: "no-key" });
  });

  test("returns `denied` without subscribing when permission was never granted", async () => {
    useEnv({});
    let subscribed = false;
    useBrowser({
      permission: "default",
      subscribe: async () => {
        subscribed = true;
        return { endpoint: ENDPOINT, toJSON() {} };
      },
    });

    assert.deepEqual(await subscribeIfAlreadyPermitted(), { status: "denied" });
    assert.equal(subscribed, false);
  });

  test("returns `unsupported` when the browser has no PushManager", async () => {
    useEnv({});
    useBrowser({ pushManager: false });

    assert.deepEqual(await subscribeIfAlreadyPermitted(), { status: "unsupported" });
  });

  test("maps a native re-register failure onto `failed`", async () => {
    const seen: string[] = [];
    useEnv({
      nativeSupported: true,
      nativeToken: "device-token",
      registerNative: async (token: string) => {
        seen.push(token);
        throw new Error("APNs rejected the token");
      },
    });

    const outcome = await subscribeIfAlreadyPermitted();
    assert.deepEqual(seen, ["device-token"]);
    assert.equal(outcome?.status, "failed");
    if (outcome?.status !== "failed") assert.fail("expected a failed outcome");
    assert.match(outcome.message, /APNs rejected/);
  });

  test("maps a successful native re-register onto `ok`", async () => {
    useEnv({ nativeSupported: true, nativeToken: "device-token" });
    assert.deepEqual(await subscribeIfAlreadyPermitted(), { status: "ok" });
  });

  test("returns null when there is no remembered native token to re-register", async () => {
    useEnv({ nativeSupported: true, nativeToken: null });
    assert.equal(await subscribeIfAlreadyPermitted(), null);
  });
});
