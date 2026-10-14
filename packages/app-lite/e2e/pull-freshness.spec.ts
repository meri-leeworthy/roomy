/**
 * The activity feed is refreshed by pull, not push.
 *
 * `space.roomy.space.getActivityFeed` answers one caller by merging what every
 * space they joined holds, so under per-space leases the spaces behind one
 * response may be owned by different workers and no worker can push the view's
 * freshness on its own (replicable-space-workers.md §4). The server therefore
 * evicts the response from its cache and sends **no** `#invalidate` frame for a
 * message-driven change, and the client refetches on mount and on an explicit
 * refresh instead.
 *
 * Both halves are load-bearing, and this spec holds both at once:
 *
 *   1. a feed that is already mounted does NOT pick up a write (no frame
 *      arrives) — the accepted cost of pulling, and the assertion that fails if
 *      the server silently starts pushing again;
 *   2. a remount, and the refresh control, DO return the new row — the
 *      assertion that fails if the client half is missing, which is what makes
 *      suppressing the frames safe rather than a freeze.
 *
 * The third test covers the remaining clause of the contract: a refetch in
 * flight keeps the last answer on screen rather than falling back to the
 * skeleton, which is what a reader sees in the window between the mount fetch
 * starting and landing. It is held open with Playwright route interception, so
 * the assertion is deterministic rather than a race with a fast local server.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_2_MESSAGE_TEXT,
  SEED_ROOM_ID,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
  TEST_USER_DID,
} from "./fixtures.ts";

const FEED_PATH = "/xrpc/space.roomy.space.getActivityFeed";

/**
 * The text every assertion here uses to mean "the feed has resolved".
 *
 * A feed item carries only the room's newest few messages, and these tests post
 * into `#lobby` — so the seeded message in *that* room scrolls out of the window
 * as the tests run, and a probe on it would fail on the third test for reasons
 * that have nothing to do with freshness. `#general` is seeded once and never
 * written to here, so its row is a stable witness that the feed rendered.
 */
const FEED_ANCHOR_TEXT = SEED_ROOM_2_MESSAGE_TEXT;

/**
 * How long to let a frame that WOULD have been pushed arrive before asserting
 * it did not. A push on this stack is a same-process, loopback round trip —
 * milliseconds — so this is generous rather than tight.
 */
const NO_FRAME_SETTLE_MS = 2_500;

/** POST one batch of events through the real write path, as the test user. */
async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

/** A createMessage event carrying `text`, with a fresh id. */
function createMessage(text: string): Record<string, unknown> {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  return {
    id: newUlid(),
    room: SEED_ROOM_ID,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/plain", data: { $bytes: body } },
    extensions: {},
  };
}

/** Unique body fragment, so an assertion cannot match an earlier run's row. */
function uniqueText(prefix: string): string {
  return `${prefix} ${newUlid()}`;
}

/**
 * Every `getActivityFeed` request the page issues.
 *
 * Counted rather than assumed: "the mount refetched" is the claim under test,
 * and the browser is the only place that claim is observable.
 */
function watchFeedRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(FEED_PATH)) urls.push(req.url());
  });
  return urls;
}

/**
 * Load the home page and wait for its activity feed to render a seeded row —
 * proving the feed's own query resolved, not merely that the page painted.
 */
async function openHomeFeed(page: Page): Promise<void> {
  await page.goto("/");
  await waitForAuthenticated(page);
  await expect(page.getByText(FEED_ANCHOR_TEXT).first()).toBeVisible();
}

/**
 * Leave the home route and come back, client-side.
 *
 * A reload would go through the persistent-cache restore instead, which
 * invalidates what it hydrates on its own — that path would pass whether or not
 * the feed query refetches on mount. Navigating away unmounts `ActivityFeed`,
 * so this is the remount the contract is about.
 */
async function remountHomeFeed(page: Page): Promise<void> {
  await page
    .locator(`.space-switcher button[title="${SEED_SPACE_NAME}"]`)
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp("/[^/]+$"));
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Hold every `getActivityFeed` request open until `release()`, so what renders
 * is the cache rather than a response that arrived first.
 *
 * The handler re-injects `X-Test-Did` because it takes over the request from
 * the fixture's route (the appserver is in test mode and reads the caller from
 * that header).
 */
function installFeedGate(page: Page) {
  let holding = false;
  const held: Array<() => void> = [];

  void page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    if (holding && route.request().url().includes(FEED_PATH)) {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push(resolve);
      await promise;
    }
    return route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
    });
  });

  return {
    hold: (value: boolean) => {
      holding = value;
    },
    heldCount: () => held.length,
    releaseAll: () => {
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

test.describe("the activity feed is pulled, not pushed", () => {
  test("a mounted feed does not pick up a write, and a remount returns it", async ({
    page,
  }) => {
    const feedRequests = watchFeedRequests(page);
    await openHomeFeed(page);

    const text = uniqueText("pull-freshness remount");
    await sendEvents([createMessage(text)]);

    // The server evicted the feed's cached page but pushed no frame, so the
    // mounted view is unchanged. If a frame were still sent, the client would
    // invalidate and refetch the feed within this window.
    await page.waitForTimeout(NO_FRAME_SETTLE_MS);
    await expect(page.getByText(text)).toHaveCount(0);

    const before = feedRequests.length;
    await remountHomeFeed(page);

    // The remount reissues the read — that is the client half — and the new row
    // arrives with it.
    await expect(page.getByText(text).first()).toBeVisible();
    expect(feedRequests.length).toBeGreaterThan(before);
  });

  test("the refresh control returns a write made while the feed sat open", async ({
    page,
  }) => {
    await openHomeFeed(page);

    const text = uniqueText("pull-freshness refresh");
    await sendEvents([createMessage(text)]);

    await page.waitForTimeout(NO_FRAME_SETTLE_MS);
    await expect(page.getByText(text)).toHaveCount(0);

    await page.getByRole("button", { name: "Refresh activity feed" }).click();
    await expect(page.getByText(text).first()).toBeVisible();
  });

  test("a refetch in flight keeps the last answer on screen", async ({ page }) => {
    const gate = installFeedGate(page);
    await openHomeFeed(page);

    const text = uniqueText("pull-freshness in-flight");
    await sendEvents([createMessage(text)]);

    // The remount's fetch is held open, so what renders is whatever the cache
    // already held — the last answer, not a skeleton and not an error.
    gate.hold(true);
    await remountHomeFeed(page);
    await expect.poll(() => gate.heldCount()).toBeGreaterThan(0);

    await expect(page.getByText(FEED_ANCHOR_TEXT).first()).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);

    gate.releaseAll();
    await expect(page.getByText(text).first()).toBeVisible();
  });
});
