/**
 * A blocked author's message in the room timeline, through the real stack.
 *
 * The block is written the way a user writes one — the profile page's Block
 * action, through the client's own repo scope — and the appserver reads it the
 * way it reads any block: resolve the viewer's DID, then list the block
 * collection in the viewer's PDS. `e2e/launch-stack.ts` answers the fixture
 * DIDs' PLC lookups so that read can happen without leaving the process.
 *
 * What the room then renders is the server's tombstone: the indicator in the
 * avatar slot, and no body. This spec deliberately does not exercise the
 * client-side redaction pass — that one exists for a row cached *before* the
 * block, and is covered by the unit tests beside `redact.ts`.
 */

import type { Page } from "@playwright/test";
import { SCOPE_SETS } from "../src/lib/scopes.ts";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  PDS_ORIGIN,
  SEED_MEMBER_SPACE_MESSAGE_TEXT,
  SEED_MEMBER_SPACE_ROOM_PATH,
  TEST_ADMIN_DID,
  TEST_USER_DID,
} from "./fixtures.ts";

const BLOCK_COLLECTION = "space.roomy.user.block";
/** The member space's seeded message is authored by this account. */
const AUTHOR_PROFILE_PATH = `/user/${TEST_ADMIN_DID}`;

/** A block rkey is a TID: 13 chars, first char never 0/1, no `l`/`o`/`u`. */
const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/**
 * The profile page's readiness gate. The account under test has no seeded
 * display name, so the heading is not a stable signal — the Block action is
 * the thing this spec needs on screen, and `waitForAuthenticated` covers the
 * auth round-trip that has to land before it can be.
 */
async function waitForProfile(page: Page): Promise<void> {
  await waitForAuthenticated(page);
  await expect(blockButton(page)).toBeVisible({ timeout: 30_000 });
}

/** Read `repo`'s block records from the stub PDS, as any client would. */
async function listBlocks(
  page: Page,
  repo: string,
): Promise<{ uri: string; subject: unknown }[]> {
  return await page.evaluate(
    async ({ pdsOrigin, repoDid, collection }) => {
      const res = await fetch(
        `${pdsOrigin}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(repoDid)}&collection=${encodeURIComponent(collection)}`,
      );
      if (!res.ok) throw new Error(`listRecords failed: ${res.status}`);
      const body = (await res.json()) as {
        records: { uri: string; value: { subject?: unknown } }[];
      };
      return body.records.map((r) => ({ uri: r.uri, subject: r.value.subject }));
    },
    { pdsOrigin: PDS_ORIGIN, repoDid: repo, collection: BLOCK_COLLECTION },
  );
}

/**
 * Remove any block already in the user's repo, so the block this test writes is
 * the only one that can account for the result.
 */
async function clearBlocks(page: Page): Promise<void> {
  const stale = await listBlocks(page, TEST_USER_DID);
  if (stale.length === 0) return;
  await page.evaluate(
    async ({ pdsOrigin, repoDid, collection, uris }) => {
      for (const uri of uris) {
        await fetch(`${pdsOrigin}/xrpc/com.atproto.repo.deleteRecord`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoDid, collection, rkey: uri.split("/").pop() }),
        });
      }
    },
    {
      pdsOrigin: PDS_ORIGIN,
      repoDid: TEST_USER_DID,
      collection: BLOCK_COLLECTION,
      uris: stale.map((r) => r.uri),
    },
  );
}

/**
 * The scope the stub PDS authorizes repo writes against — the session's grant,
 * which a real consent round-trip would have set. `blocks` is not in the base
 * tier the test session holds, so the write is refused until a spec says
 * otherwise; this spec is about the read, not the gate.
 */
async function setGrantedScope(page: Page, scope: string): Promise<void> {
  const res = await page.request.post(`${PDS_ORIGIN}/__e2e/granted-scope`, {
    data: { scope },
  });
  expect(res.ok()).toBe(true);
}

const blockButton = (page: Page) =>
  page.getByRole("button", { name: "Block this user" });
const unblockButton = (page: Page) =>
  page.getByRole("button", { name: "Unblock this user" });
const indicator = (page: Page) => page.getByTestId("blocked-indicator");

test.describe("a blocked author in the room timeline", () => {
  test("their message renders as the indicator, with no body", async ({ page }) => {
    // ── Block the member space's message author, through the UI ──────────
    await page.goto(AUTHOR_PROFILE_PATH);
    await waitForProfile(page);
    await clearBlocks(page);
    await setGrantedScope(page, SCOPE_SETS.blocks);

    await expect(blockButton(page)).toBeVisible();
    await blockButton(page).click();
    await expect(unblockButton(page)).toBeVisible();

    const records = await listBlocks(page, TEST_USER_DID);
    expect(records).toHaveLength(1);
    expect(records[0]?.subject).toBe(TEST_ADMIN_DID);
    expect(records[0]?.uri.split("/").pop() ?? "").toMatch(TID_PATTERN);

    // ── Read the room ───────────────────────────────────────────────────
    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);

    // The timeline rendered, and the row is still there — a tombstone keeps its
    // place, which is what keeps the scrollback contiguous and the page's
    // cursor correct.
    await expect(indicator(page)).toHaveCount(1);
    await expect(page.locator(`[data-message-id]`)).toHaveCount(1);

    // ...and the body is gone. Nothing was fetched into the DOM to hide it.
    await expect(page.locator("ol")).not.toContainText(
      SEED_MEMBER_SPACE_MESSAGE_TEXT,
    );
    // The author's identity is not rendered either: no name, no avatar.
    await expect(page.locator("ol")).not.toContainText("E2E Admin");
  });

  test("the unblocked case still renders the message", async ({ page }) => {
    await page.goto(AUTHOR_PROFILE_PATH);
    await waitForProfile(page);
    await setGrantedScope(page, SCOPE_SETS.blocks);

    // Unblock through the UI rather than by deleting the record behind the
    // app's back. The appserver holds the viewer's block set for a minute, and
    // it is the *write path* that drops that memo (`refreshBlocks`); a raw
    // delete would leave the room tombstoned and this test asserting the last
    // test's state. Nothing to unblock is the ordinary case for a first run.
    if (await unblockButton(page).isVisible()) {
      await unblockButton(page).click();
      await expect(blockButton(page)).toBeVisible();
    }
    await clearBlocks(page);

    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);

    await expect(page.locator("ol")).toContainText(SEED_MEMBER_SPACE_MESSAGE_TEXT);
    await expect(indicator(page)).toHaveCount(0);
  });
});
