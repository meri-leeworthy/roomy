import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installNativePushListeners } from "./native-push";

/**
 * The tap path, end to end across the seam the client owns: a plugin event
 * arrives → the installed listener routes it. `push-route.spec.ts` covers the
 * payload contract in isolation; this covers the wiring — which listeners are
 * installed, what they do with a payload, and what happens on the web, where
 * there is no plugin at all.
 *
 * Both boundaries are mocked: the plugin module (loaded by a dynamic `import()`
 * inside the module under test, and never resolvable on the web) and
 * SvelteKit's router.
 */

const { goto, listeners } = vi.hoisted(() => ({
  goto: vi.fn(),
  /** The handler the module installed, per plugin event name. */
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("$app/navigation", () => ({ goto }));

vi.mock("tauri-plugin-mobile-push-api", () => ({
  onNotificationReceived: async (handler: (payload: unknown) => void) => {
    listeners.set("notification-received", handler);
    return { unregister: async () => listeners.delete("notification-received") };
  },
  onNotificationTapped: async (handler: (payload: unknown) => void) => {
    listeners.set("notification-tapped", handler);
    return { unregister: async () => listeners.delete("notification-tapped") };
  },
  onTokenRefresh: async () => ({ unregister: async () => {} }),
}));

/** Stands in for the shell global: `os.platform()` classifies the runtime. */
function reportPlatform(platform: string): void {
  vi.stubGlobal("window", { __TAURI__: { os: { platform: () => platform } } });
}

/** The event the plugin projects from the APNs payload the appserver sent. */
function apnsEvent(payload: Record<string, unknown>): unknown {
  return { title: "lobby", body: "New message", data: { roomy: JSON.stringify(payload) } };
}

/** Awaits the async registration `installNativePushListeners` kicks off. */
async function listenersReady(): Promise<void> {
  await vi.waitFor(() => {
    expect(listeners.has("notification-tapped")).toBe(true);
  });
}

describe("installNativePushListeners", () => {
  beforeEach(() => {
    goto.mockClear();
    listeners.clear();
    reportPlatform("ios");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("installs nothing when the shell has no native push transport", async () => {
    reportPlatform("macos");
    const dispose = installNativePushListeners();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
    expect(goto).not.toHaveBeenCalled();
    dispose();
  });

  it("deep-links a tap to the room and highlights the message", async () => {
    const dispose = installNativePushListeners();
    await listenersReady();

    listeners.get("notification-tapped")!(
      apnsEvent({ type: "message", spaceId: "s1", roomId: "r1", messageId: "m1", count: 1 }),
    );

    expect(goto).toHaveBeenCalledWith("/s1/r1?message=m1");
    dispose();
  });

  it("lands a digest tap at the room, with no message anchor", async () => {
    const dispose = installNativePushListeners();
    await listenersReady();

    listeners.get("notification-tapped")!(
      apnsEvent({ type: "digest", spaceId: "s1", roomId: "r1", count: 9 }),
    );

    expect(goto).toHaveBeenCalledWith("/s1/r1");
    dispose();
  });

  it("routes the foreground `notification-received` event the same way", async () => {
    const dispose = installNativePushListeners();
    await listenersReady();

    listeners.get("notification-received")!(
      apnsEvent({ type: "message", spaceId: "s1", roomId: "r1", messageId: "m1", count: 1 }),
    );

    expect(goto).toHaveBeenCalledWith("/s1/r1?message=m1");
    dispose();
  });

  it("stays put, without throwing, on a payload it cannot route", () => {
    const dispose = installNativePushListeners();
    return listenersReady().then(() => {
      // A tap on an app launched before the appserver had a room row, say: the
      // listener must absorb it rather than break the plugin's event loop.
      expect(() => listeners.get("notification-tapped")!({ title: "hi" })).not.toThrow();
      expect(goto).not.toHaveBeenCalled();
      dispose();
    });
  });
});
