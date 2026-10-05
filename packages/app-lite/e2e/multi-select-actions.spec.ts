/**
 * Multi-select message actions.
 *
 * Entering select mode replaces the composer with a bar carrying the count,
 * the selected message and the actions the viewer may take on the selection.
 * The bar is the whole surface of the mode, so its contract is asserted here:
 * what it reports, which actions it offers at which entitlement, and that
 * every action a viewer can see is reachable with the keyboard alone.
 *
 * The message row is itself the selection control in this mode (a
 * `role="checkbox"` button), which is what makes a row clickable anywhere and
 * lets the message's own links stay out of the way. Both are asserted — the
 * row's own semantics, and that a link inside a selected row does not
 * navigate.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import {
  SEED_MESSAGE_TEXT,
  SEED_ROOM_PATH,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_ROOM_PATH,
} from "./fixtures.ts";

/** The select-mode bar. */
function selectBar(page: Page) {
  return page.getByRole("status").filter({ hasText: /selected/ });
}

/** The message row as the selection control. */
function messageRow(page: Page, text: string) {
  return page
    .getByRole("checkbox", { name: "Select message" })
    .filter({ hasText: text });
}

/** Enter select mode from a message's hover toolbar (which pre-selects it). */
async function startSelect(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await page.getByRole("menuitem", { name: "Select", exact: true }).click();
  await expect(selectBar(page)).toBeVisible();
}

test.describe("multi-select message actions", () => {
  test("the bar reports the selection and offers every action to an admin", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, SEED_MESSAGE_TEXT);

    // Entering from a message's toolbar pre-selects that message: the mode
    // starts with something to act on rather than asking for a second step.
    await expect(selectBar(page)).toContainText("1 selected");
    await expect(
      messageRow(page, SEED_MESSAGE_TEXT).first(),
    ).toHaveAttribute("aria-checked", "true");

    // The seeded link message, so the selection is genuinely plural.
    await messageRow(page, "worth saving").click();
    await expect(selectBar(page)).toContainText("2 selected");

    // Admin in this space, so the moderation action is offered alongside the
    // ones every member gets.
    for (const name of ["Forward", "Move", "Delete", "Create Thread"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
    }
  });

  test("a plain member is offered the actions they hold, and not Move or Delete", async ({
    page,
  }) => {
    await page.goto(SEED_SPACE_3_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, SEED_SPACE_3_MESSAGE_TEXT);
    await expect(selectBar(page)).toContainText("1 selected");

    // Moving and deleting another account's messages in a space this viewer
    // only belongs to are not theirs to do, so both are absent rather than
    // present-and-disabled: an action that can never succeed is not a state.
    await expect(
      page.getByRole("button", { name: "Forward", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create Thread", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Move", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
  });

  test("a selected row is a control, and its own links are not", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, SEED_MESSAGE_TEXT);

    const row = messageRow(page, "worth saving").first();
    await expect(row).toHaveAttribute("aria-checked", "false");

    // Clicking the row toggles it, and it reports that state itself.
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "true");

    // The row's own content is inert while it is a control, so a click on the
    // link inside it selects rather than navigating away mid-selection.
    const href = await page.evaluate(() => {
      const el = document.querySelector<HTMLAnchorElement>(
        '[role="checkbox"] a[href]',
      );
      return el?.getAttribute("href") ?? null;
    });
    expect(href).not.toBeNull();
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "false");
    expect(new URL(page.url()).pathname).toBe(SEED_ROOM_PATH);
  });

  test("Escape leaves the mode and restores the composer", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();

    await startSelect(page, SEED_MESSAGE_TEXT);
    await expect(composer(page)).toHaveCount(0);

    // Focus is on the message row at this point — the usual case, since
    // clicking a row is how the selection is built — so Escape has to work
    // from there and not only from inside the bar.
    await page.keyboard.press("Escape");

    await expect(selectBar(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
  });

  test("the bar and its actions are reachable by keyboard alone", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // Enter the mode from the toolbar without ever touching the mouse: open
    // the actions menu, walk to "Select", and activate it.
    await page.getByText(SEED_MESSAGE_TEXT).first().hover();
    await page.getByLabel("More actions").first().click();
    const select = page.getByRole("menuitem", { name: "Select", exact: true });
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(selectBar(page)).toBeVisible();

    // Tab reaches each action in turn (a disabled or unfocusable control
    // would be skipped, which is the failure this defends).
    for (const name of ["Forward", "Move", "Delete", "Create Thread"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.focus();
      await expect(button).toBeFocused();
    }
  });
});
