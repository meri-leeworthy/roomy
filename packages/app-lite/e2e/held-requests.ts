/**
 * A route handler that authenticates (the appserver is in test mode) and can
 * hold `room.getMessages` requests open.
 *
 * Both cache specs need the same thing: a reload whose message refetch has not
 * resolved yet, so whatever is on screen can only have come from the store. The
 * gate is what makes "rendered from the store" an assertion rather than an
 * inference — without it a response could have repaired the view first.
 *
 * `heldCount` is the positive side of the same claim: the restore invalidated
 * the key it hydrated, so the mount must have started a fetch. A held request
 * proves it is in flight, not merely scheduled.
 */
import type { Page } from "@playwright/test";
import { APPSERVER_HTTP_ORIGIN, TEST_USER_DID } from "./fixtures.ts";

export interface RequestGate {
  /** `page.route`'s registration promise; awaiting it installs the handler. */
  install: Promise<unknown>;
  stall(value: boolean): void;
  heldCount(): number;
  releaseAll(): void;
}
export function installGate(page: Page): RequestGate {
  let stall = false;
  const held: Array<{ release: () => void }> = [];

  const install = page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (stall && url.includes("room.getMessages")) {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ release: resolve });
      await promise;
    }
    return route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
    });
  });

  return {
    install,
    stall: (value: boolean) => {
      stall = value;
    },
    heldCount: () => held.length,
    releaseAll: () => {
      for (const entry of held.splice(0)) entry.release();
    },
  };
}
