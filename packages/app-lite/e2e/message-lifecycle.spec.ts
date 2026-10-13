/**
 * The message lifecycle — reply, react, delete, and the send path's edges.
 *
 * This is the rest of the coverage plan's area A ("Message lifecycle (highest
 * value — this is what the app *is*)"). Parts of the area are already owned by
 * other specs, and are deliberately NOT re-tested here:
 *
 *   - `send-message.spec.ts` — the plain write path: appears, survives a
 *     reload, clears the composer.
 *   - `message-edit.spec.ts` — the edit round-trip, the no-op save, Escape.
 *   - `multi-select-actions.spec.ts` / `forward-order.spec.ts` — batch
 *     selection, forward and move.
 *   - `delete-freeze.spec.ts` — that a toolbar delete leaves the page
 *     clickable (it asserts the row leaves, but never that it stays gone).
 *   - `write-refusal.spec.ts` / `write-rematerialising.spec.ts` — a send the
 *     appserver refuses (403) or holds back (409).
 *
 * What is left, and what each test here defends:
 *
 *   - a reply renders the replied-to message's context on the new row, from a
 *     `replyTo` attachment that survived materialisation (asserted after a
 *     reload, so only the appserver can be supplying it);
 *   - a reaction appears on the row and persists;
 *   - a delete removes the row for the author, and for an admin deleting
 *     someone else's message — and stays gone after a reload (a client-only
 *     removal would come back);
 *   - a send the appserver rejects is marked "Not sent" with working Retry
 *     and Discard;
 *   - markdown-ish input renders as blocks;
 *   - each room keeps its own composer draft;
 *   - Enter and the Send button produce identical bodies.
 *
 * Every message these tests act on is posted through the real `sendEvents`
 * write path and addressed by its `data-message-id`, so the assertions target
 * the row they name rather than whatever text happens to be first in the list.
 */

import type { Locator, Page, Route } from "@playwright/test";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import { composer, expect, test } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_MEMBER_SPACE_ID,
  SEED_MEMBER_SPACE_ROOM_ID,
  SEED_MEMBER_SPACE_ROOM_PATH,
  SEED_ROOM_2_PATH,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_ADMIN_DID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** The XRPC procedure a send goes through. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";
/** The XRPC query the room's timeline is read from. */
const GET_MESSAGES_PATH = "/xrpc/space.roomy.room.getMessages";

/** Unique body fragment, so assertions can't match an earlier run's row. */
let seq = 0;
function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${seq++}`;
}

/** The row carrying the message with `id`. */
function messageRow(page: Page, id: string): Locator {
  return page.locator(`[data-message-id="${id}"]`);
}

/** The rows whose content contains `text`. */
function rowsWithText(page: Page, text: string): Locator {
  return page.locator("[data-message-id]").filter({ hasText: text });
}

/**
 * Messages this test created, for cleanup.
 *
 * The seeded rooms are shared by the whole suite and several specs assert on
 * the *oldest* message in one (`navigation-consistency.spec.ts` on each
 * channel's first message, `message-toolbar-menu.spec.ts` and
 * `semble-personal.spec.ts` on the lobby's link message). The timeline is
 * virtualized and paged at 50, so a room that grows enough stops rendering —
 * or stops loading — the rows those specs address. Leaving this spec's
 * messages behind would make them the marginal cause of exactly that, so each
 * test deletes what it posted.
 */
type CreatedMessage = { spaceId: string; roomId: string; id: string };
let created: CreatedMessage[] = [];

test.beforeEach(() => {
  created = [];
});

test.afterEach(async () => {
  const mine = created;
  created = [];
  for (const entry of mine) {
    // Best-effort: this is hygiene, not the assertion under test. A message
    // the test already deleted, or one whose send it left unacknowledged, has
    // no author edge — its delete is refused, and that refusal must not fail
    // an otherwise passing test.
    await sendEvents(entry.spaceId, [
      {
        id: newUlid(),
        room: entry.roomId,
        $type: "space.roomy.message.deleteMessage.v0",
        messageId: entry.id,
      },
    ]).catch(() => {});
  }
});

/** Remember a message so the test's cleanup deletes it afterwards. */
function track(spaceId: string, roomId: string, id: string): string {
  created.push({ spaceId, roomId, id });
  return id;
}

/** The message a rendered row stands for, remembered for cleanup. */
async function trackRow(
  spaceId: string,
  roomId: string,
  row: Locator,
): Promise<string> {
  const id = await row.getAttribute("data-message-id");
  if (!id) throw new Error("row carries no data-message-id");
  return track(spaceId, roomId, id);
}

/** POST one batch of events through the real write path. */
async function sendEvents(
  spaceId: string,
  events: Record<string, unknown>[],
  callerDid: string = TEST_USER_DID,
): Promise<void> {
  const resp = await fetch(`${APPSERVER_HTTP_ORIGIN}${SEND_EVENTS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Did": callerDid },
    body: JSON.stringify({ spaceId, events }),
  });
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

type Posted = { id: string; text: string };

/**
 * Post one message through the real write path, as `callerDid`.
 *
 * The body is the same blocks+facets document the composer produces, so what
 * the tests act on is exactly what the app writes.
 */
async function postMessage(opts: {
  spaceId: string;
  roomId: string;
  text: string;
  callerDid?: string;
}): Promise<Posted> {
  const id = newUlid();
  const serialized = serializeBlocks([
    { $type: "space.roomy.richtext.blocks#text", text: opts.text },
  ]);
  await sendEvents(
    opts.spaceId,
    [
      {
        id,
        room: opts.roomId,
        $type: "space.roomy.message.createMessage.v0",
        body: {
          mimeType: serialized.mimeType,
          data: { $bytes: Buffer.from(serialized.data).toString("base64") },
        },
        extensions: {},
      },
    ],
    opts.callerDid,
  );
  return { id: track(opts.spaceId, opts.roomId, id), text: opts.text };
}

/** One message as the appserver stores it. */
type StoredMessage = { id: string; mimeType: string; content: string };

/** The room's timeline, read straight from the appserver. */
async function readMessages(roomId: string): Promise<StoredMessage[]> {
  const url = new URL(`${APPSERVER_HTTP_ORIGIN}${GET_MESSAGES_PATH}`);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("limit", "50");
  const resp = await fetch(url, { headers: { "X-Test-Did": TEST_USER_DID } });
  if (!resp.ok) {
    throw new Error(`getMessages failed ${resp.status}: ${await resp.text()}`);
  }
  const body = (await resp.json()) as { messages: StoredMessage[] };
  return body.messages;
}

/** The app-lite composer editor is mounted (and only one of it is). */
async function waitForComposer(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect(page.locator("#chat-input")).toHaveCount(1, {
    timeout: timeoutMs,
  });
  await expect(composer(page)).toBeVisible({ timeout: timeoutMs });
}

/**
 * Open a room and wait until its composer is live.
 *
 * The composer is the precondition every test here needs — an authenticated
 * caller, a resolved room, and write access — and it is what the tests then
 * type into. It deliberately does not wait on the sidebar's user card
 * (`waitForAuthenticated`): that card comes from a profile round-trip this
 * spec never reads, and on a cold stack it is the slowest thing on the page.
 */
async function openRoom(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForComposer(page, 45_000);
}

/** Type `text` into the composer the way a person does, key by key. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  await waitForComposer(page);
  const input = composer(page);
  await input.click();
  // `pressSequentially` fires per-key events, which is what the rich-text
  // editor's input rules key off — `fill` would set the DOM without the
  // editor observing it, and no markdown shortcut would fire.
  await input.pressSequentially(text);
}

/** Submit through the Send button. */
async function clickSend(page: Page): Promise<void> {
  const send = page.getByTestId("send-message-button");
  await expect(send).toBeVisible();
  await send.click();
}

/**
 * Click a control in a row's hover toolbar, retrying until it takes.
 *
 * A row's toolbar mounts only while the pointer rests on that row, and the
 * chat list keeps moving after a row is first scrolled to: the autoscroll to
 * the newest message and the virtualizer's re-measure both slide rows under a
 * stationary pointer, which takes the toolbar — and with it the button the
 * click was aimed at — off that row. So each attempt re-positions and
 * re-hovers the row, and the attempt only counts as done once `settled`
 * reports the effect the click was supposed to have, which is what makes a
 * click that landed on the wrong row (or nowhere) a retry rather than a
 * failure.
 */
async function clickRowToolbar(
  page: Page,
  row: Locator,
  control: (row: Locator) => Locator,
  settled: () => Promise<boolean>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await row.hover({ timeout: 5_000 }).catch(() => {});
        const button = control(row);
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => {});
        }
        return settled();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Hover the row and open its "More actions" menu. */
async function openRowMenu(page: Page, row: Locator): Promise<void> {
  await clickRowToolbar(
    page,
    row,
    (r) => r.getByLabel("More actions"),
    () => menuIsOpen(page),
  );
}

/** Whether a row's actions menu is open. */
function menuIsOpen(page: Page): Promise<boolean> {
  return page
    .getByRole("menuitem", { name: "Delete", exact: true })
    .isVisible()
    .catch(() => false);
}

/**
 * Authenticate the page's appserver requests as `did`, replacing the seeded
 * user the fixture injects. Registered after the fixture's catch-all, so it
 * runs first and its header wins.
 */
async function authenticateAs(page: Page, did: string): Promise<void> {
  await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": did },
    });
  });
}

/** Confirm the delete dialog raised from a row's toolbar. */
async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("button", { name: /Delete Message/i }).first();
  await expect(confirm).toBeVisible();
  await confirm.click();
}

/**
 * Fail the first `sendEvents` POST with an opaque server error, and let every
 * later one through to the real appserver.
 *
 * Registered after the fixture's catch-all, so it runs first; `fallback()`
 * hands every other request (including the retry) back to the fixture, which
 * injects the test identity. A 500 is used rather than a 403 or a 409 so the
 * failure is the generic one: the access-refusal and mid-rebuild paths have
 * their own specs.
 */
function failFirstSend(page: Page): { sends: number; failures: number } {
  const counts = { sends: 0, failures: 0 };
  void page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route: Route) => {
    const request = route.request();
    if (
      new URL(request.url()).pathname !== SEND_EVENTS_PATH ||
      request.method() !== "POST"
    ) {
      await route.fallback();
      return;
    }
    counts.sends++;
    if (counts.failures > 0) {
      await route.fallback();
      return;
    }
    counts.failures++;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        error: "InternalServerError",
        message: "the room's log is unavailable",
      }),
    });
  });
  return counts;
}

test.describe("replying to a message", () => {
  test("renders the replied-to message on the new row, and it survives a reload", async ({
    page,
  }) => {
    const target = await postMessage({
      spaceId: SEED_SPACE_ID,
      roomId: SEED_ROOM_ID,
      text: uniqueText("reply target"),
    });

    await openRoom(page, SEED_ROOM_PATH);

    const targetRow = messageRow(page, target.id);
    await expect(targetRow).toBeVisible();
    // The composer takes the reply context — the strip above the editor names
    // the message being replied to — which is also how the click reports that
    // it landed on this row's Reply and not another row's.
    const replyContext = page.getByRole("button").filter({ hasText: target.text });
    await clickRowToolbar(
      page,
      targetRow,
      (r) => r.getByLabel("Reply"),
      () => replyContext.isVisible().catch(() => false),
    );
    await expect(replyContext).toBeVisible();

    const replyText = uniqueText("reply body");
    await typeInComposer(page, replyText);
    await clickSend(page);

    const replyRow = rowsWithText(page, replyText);
    await expect(replyRow).toBeVisible();
    await trackRow(SEED_SPACE_ID, SEED_ROOM_ID, replyRow);
    await expect(replyRow).toContainText(target.text);

    // Only the appserver can supply the reply context after a reload, so this
    // is what proves the reply attachment was written and materialised rather
    // than rendered from the composer's own state.
    await page.reload();
    await waitForComposer(page, 45_000);

    const afterReload = rowsWithText(page, replyText);
    await expect(afterReload).toBeVisible();
    await expect(afterReload).toContainText(target.text);
  });
});

test.describe("reacting to a message", () => {
  test("the reaction lands on the row and survives a reload", async ({
    page,
  }) => {
    const target = await postMessage({
      spaceId: SEED_SPACE_ID,
      roomId: SEED_ROOM_ID,
      text: uniqueText("reaction target"),
    });

    await openRoom(page, SEED_ROOM_PATH);

    const row = messageRow(page, target.id);
    await expect(row).toBeVisible();
    // The hover toolbar's quick reactions. `.first()` because once the
    // reaction lands, the reaction bar's own 👍 control carries the same name;
    // the toolbar's is first in the row. The poll converges on the row holding
    // a pressed toggle, so a click that missed (or toggled the reaction off
    // again) is retried rather than reported as a failure.
    const pressed = () => row.getByRole("button", { pressed: true });
    await clickRowToolbar(
      page,
      row,
      (r) => r.getByRole("button", { name: "👍" }).first(),
      async () => (await pressed().count()) === 1,
    );

    // The reaction bar's toggle is the only *pressed* button in the row — the
    // toolbar's quick-reaction buttons are plain buttons.
    await expect(pressed()).toHaveCount(1);
    await expect(pressed()).toContainText("👍");

    await page.reload();
    await waitForComposer(page, 45_000);

    // Nothing is hovered after the reload, so the toolbar (and its 👍 button)
    // is not mounted: the pressed toggle can only be the materialised reaction.
    const afterReload = messageRow(page, target.id);
    await expect(afterReload.getByRole("button", { pressed: true })).toHaveCount(
      1,
    );
    await expect(
      afterReload.getByRole("button", { pressed: true }),
    ).toContainText("👍");
  });
});

test.describe("deleting a message", () => {
  test("the author's delete removes the row, and a reload does not bring it back", async ({
    page,
  }) => {
    const target = await postMessage({
      spaceId: SEED_SPACE_ID,
      roomId: SEED_ROOM_ID,
      text: uniqueText("own message to delete"),
    });

    await openRoom(page, SEED_ROOM_PATH);

    const row = messageRow(page, target.id);
    await expect(row).toBeVisible();
    await openRowMenu(page, row);
    await confirmDelete(page);

    await expect(row).toHaveCount(0);

    // A removal that only emptied the client cache would come back here; the
    // row can only stay gone if the delete reached the log.
    await page.reload();
    await waitForComposer(page, 45_000);
    await expect(messageRow(page, target.id)).toHaveCount(0);
  });

  test("an admin deletes another account's message, and a reload does not bring it back", async ({
    page,
  }) => {
    // The message is the seeded user's, in a space where they are a plain
    // member; the page authenticates as that space's admin, so the delete is a
    // moderation action rather than the author's own.
    const target = await postMessage({
      spaceId: SEED_MEMBER_SPACE_ID,
      roomId: SEED_MEMBER_SPACE_ROOM_ID,
      text: uniqueText("another account's message to delete"),
    });
    await authenticateAs(page, TEST_ADMIN_DID);

    await openRoom(page, SEED_MEMBER_SPACE_ROOM_PATH);

    const row = messageRow(page, target.id);
    await expect(row).toBeVisible();
    await openRowMenu(page, row);
    await confirmDelete(page);

    await expect(row).toHaveCount(0);

    await page.reload();
    await waitForComposer(page, 45_000);
    await expect(messageRow(page, target.id)).toHaveCount(0);
  });
});

test.describe("a send the appserver rejects", () => {
  test("marks the row Not sent, and Retry delivers it", async ({ page }) => {
    const counts = failFirstSend(page);

    await openRoom(page, SEED_ROOM_PATH);

    const text = uniqueText("send that fails");
    await typeInComposer(page, text);
    await clickSend(page);

    const row = rowsWithText(page, text);
    await expect(row).toBeVisible();

    // Scoped to the row: the failure toast says "Message not sent", which an
    // unscoped, case-insensitive match would also satisfy.
    await expect(row.getByText("Not sent")).toBeVisible();
    await expect(row.getByRole("button", { name: "Retry sending" })).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Discard message" }),
    ).toBeVisible();
    expect(counts.failures).toBe(1);

    // Retry resends the retained event under its original ULID, and this time
    // the appserver takes it — so the marker clears without a reload.
    await row.getByRole("button", { name: "Retry sending" }).click();
    await expect(row.getByText("Not sent")).toHaveCount(0);
    expect(counts.sends).toBe(2);
    // Only now has the message reached the log, so only now is there a row
    // for the cleanup to delete.
    await trackRow(SEED_SPACE_ID, SEED_ROOM_ID, row);

    await page.reload();
    await waitForComposer(page, 45_000);
    await expect(rowsWithText(page, text)).toBeVisible();
  });

  test("Discard drops the row, and nothing was written", async ({ page }) => {
    failFirstSend(page);

    await openRoom(page, SEED_ROOM_PATH);

    const text = uniqueText("send to discard");
    await typeInComposer(page, text);
    await clickSend(page);

    const row = rowsWithText(page, text);
    await expect(row.getByText("Not sent")).toBeVisible();

    await row.getByRole("button", { name: "Discard message" }).click();
    await expect(row).toHaveCount(0);

    // The send never reached the log, so the reloaded room holds no row for it.
    await page.reload();
    await waitForComposer(page, 45_000);
    await expect(rowsWithText(page, text)).toHaveCount(0);
  });
});

test.describe("markdown-ish input", () => {
  test("bold, code, a list and a link all render as blocks", async ({
    page,
  }) => {
    await openRoom(page, SEED_ROOM_PATH);

    const token = uniqueText("blocks");
    const url = "https://markdown-blocks.invalid/article";

    await waitForComposer(page);
    const input = composer(page);
    await input.click();
    // The editor converts markdown *shortcuts* as they are typed (the input
    // rules), rather than storing markdown to be re-parsed on render: that is
    // the WYSIWYG contract between the composer and the rendered message.
    await input.pressSequentially(`**bold** and \`code\` ${token}`);
    // Shift+Enter starts a new block without sending; a bare Enter would send.
    await input.press("Shift+Enter");
    await input.pressSequentially(`${url} `);
    await input.press("Shift+Enter");
    await input.pressSequentially("- item one");
    await clickSend(page);
    const row = rowsWithText(page, token);
    await expect(row).toBeVisible();
    await trackRow(SEED_SPACE_ID, SEED_ROOM_ID, row);

    await expect(row.locator("strong")).toHaveText("bold");
    await expect(row.locator("code")).toHaveText("code");
    await expect(row.locator("ul li")).toContainText("item one");
    await expect(row.locator(`a[href="${url}"]`)).toBeVisible();
  });
});

test.describe("composer drafts", () => {
  test("each room keeps its own draft across a room switch", async ({
    page,
  }) => {
    await openRoom(page, SEED_ROOM_PATH);

    const lobbyDraft = uniqueText("draft for lobby");
    await typeInComposer(page, lobbyDraft);
    await expect(composer(page)).toContainText(lobbyDraft);

    // In-app navigation, so the module-level draft store survives; a `goto`
    // would reload the page and take the drafts with it.
    await page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_2_PATH}"]`).first().click();
    await waitForComposer(page);

    // The other room starts empty: a draft is not shared between rooms.
    await expect(composer(page)).not.toContainText(lobbyDraft);

    const generalDraft = uniqueText("draft for general");
    const generalComposer = composer(page);
    await generalComposer.click();
    await generalComposer.pressSequentially(generalDraft);

    await page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_PATH}"]`).first().click();
    await waitForComposer(page);

    // The first room's draft is recalled, and it is that room's own.
    await expect(composer(page)).toContainText(lobbyDraft);
    await expect(composer(page)).not.toContainText(generalDraft);
  });
});

test.describe("submitting a message", () => {
  test("Enter and the Send button encode identical bodies", async ({
    page,
  }) => {
    await openRoom(page, SEED_ROOM_PATH);

    const text = uniqueText("identical body");
    // A trailing URL: turning it into a link facet is the flush `submit()`
    // performs, so an entry point that serialized on its own would write a
    // different body — or lose the link — for the same keystrokes.
    const url = "https://identical-body.invalid/x";
    const body = `${text} ${url}`;

    await typeInComposer(page, body);
    await composer(page).press("Enter");

    const rows = rowsWithText(page, body);
    await expect(rows).toHaveCount(1);
    const enterId = await rows.first().getAttribute("data-message-id");
    expect(enterId).not.toBeNull();

    await typeInComposer(page, body);
    await clickSend(page);
    await expect(rows).toHaveCount(2);

    const ids = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-message-id")),
    );
    const buttonId = ids.find((id) => id !== enterId);
    expect(buttonId).toBeTruthy();

    const messages = await readMessages(SEED_ROOM_ID);
    const viaEnter = messages.find((m) => m.id === enterId);
    const viaButton = messages.find((m) => m.id === buttonId);
    expect(viaEnter).toBeDefined();
    expect(viaButton).toBeDefined();
    expect(viaButton!.mimeType).toBe(viaEnter!.mimeType);
    expect(viaButton!.content).toBe(viaEnter!.content);

    track(SEED_SPACE_ID, SEED_ROOM_ID, enterId!);
    track(SEED_SPACE_ID, SEED_ROOM_ID, buttonId!);
  });
});
