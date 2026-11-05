/**
 * Space discovery and the admins' suggestion prompt.
 *
 * Defends the two halves of the suggestion setting that no screen owned before:
 * the Discover Spaces strip is driven by the server's policy (a space that opts
 * out cannot appear, whatever the client does), and an admin of a space whose
 * admins have not answered is asked once, with the dismissal remembered per
 * user.
 *
 * The opt-out is written through the real `sendEvents` path as the public
 * space's own admin, so the assertion covers materialisation and the
 * `space_discovery` projection refresh, not just a row written behind them.
 */

import type { Page } from "@playwright/test";

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_PUBLIC_SPACE_ID,
  SEED_PUBLIC_SPACE_NAME,
  SEED_PUBLIC_SPACE_OWNER_DID,
  TEST_NON_MEMBER_DID,
} from "./fixtures.ts";

/** A ULID that is never used by the fixture. */
const OPT_OUT_EVENT_ID = "01M3C8QTVS0000000000000099";

async function setSuggested(
  page: Page,
  suggested: boolean,
  eventId: string,
): Promise<void> {
  const res = await page.request.post(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": SEED_PUBLIC_SPACE_OWNER_DID,
      },
      data: {
        spaceId: SEED_PUBLIC_SPACE_ID,
        events: [
          {
            id: eventId,
            $type: "space.roomy.space.updateSpaceInfo.v0",
            suggestToOthers: suggested,
          },
        ],
      },
    },
  );
  expect(res.ok()).toBeTruthy();
}

test.describe("discover spaces", () => {
  test("drops a space from the strip once its admins opt out", async ({
    page,
  }) => {
    const card = page.locator(`a[href="/${SEED_PUBLIC_SPACE_ID}"]`);

    await page.goto("/");
    await waitForAuthenticated(page);

    await expect(
      page.getByRole("heading", { name: "Discover Spaces" }),
    ).toBeVisible();
    await expect(card).toBeVisible();
    await expect(card).toContainText(SEED_PUBLIC_SPACE_NAME);

    // The viewer is not a member, so the only thing that can remove the card is
    // the space's own setting.
    await setSuggested(page, false, OPT_OUT_EVENT_ID);
    await page.reload();
    await waitForAuthenticated(page);

    await expect(card).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Discover Spaces" }),
    ).toHaveCount(0);

    // Put the seeded world back for any spec that runs after this one.
    await setSuggested(page, true, "01M3C8QTVS0000000000000098");
  });
});

test.describe("suggest-to-others prompt", () => {
  const bannerText = "suggested to other people";

  test("asks an admin of an unanswered space and stays dismissed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    const banner = page.getByRole("banner").filter({ hasText: bannerText });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Dismiss" }).click();
    await expect(banner).toHaveCount(0);

    // Dismissal is recorded for this user, so a reload does not ask again.
    await page.reload();
    await waitForAuthenticated(page);
    await expect(
      page.getByRole("banner").filter({ hasText: bannerText }),
    ).toHaveCount(0);
  });

  test("links to the settings page of the space it asks about", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    await page
      .getByRole("banner")
      .filter({ hasText: bannerText })
      .click();

    await expect(page).toHaveURL(/\/settings$/);
    // The form's suggestion control is on the page it lands on.
    await expect(page.locator('input[name="suggestToOthers"]').first()).toBeVisible();
  });

  test("never applies to a plain member", async ({ page }) => {
    // The viewer's own list is what the prompt reads; for an account that is
    // only a member of its spaces, no row qualifies.
    const res = await page.request.get(
      `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.getSpaces`,
      { headers: { "X-Test-Did": TEST_NON_MEMBER_DID } },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      spaces: Array<{ isAdmin: boolean; suggestToOthers?: boolean | null }>;
    };

    expect(body.spaces.length).toBeGreaterThan(0);
    expect(
      body.spaces.filter(
        (s) => s.isAdmin && s.suggestToOthers === null,
      ),
    ).toHaveLength(0);
  });
});
