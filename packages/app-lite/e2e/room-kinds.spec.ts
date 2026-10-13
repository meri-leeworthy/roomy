/**
 * Room kinds and board views.
 *
 * Defends the four area-B behaviours: creating a thread from the composer menu
 * and landing in its chat, a channel's Chat/Threads/Links tabs with Links
 * behind the `links-view` flag, the space index board's activity-ordered
 * listing of the space's rooms, and the unread marker a room with unseen
 * messages carries.
 *
 * Rooms and messages are written through the real `sendEvents` path (HTTP,
 * `X-Test-Did`), so each assertion reads something the materialiser built. The
 * thread-creating test is the exception and drives the UI itself: it is the
 * only way to cover the composer's thread flow, which writes a room AND its
 * canonical parent link.
 *
 * A room's unread count is the messages posted after the reader's stored
 * watermark, so the unread tests are ordered in time rather than waited on:
 * post, then assert. Every wait is a locator assertion — there is no
 * `waitForTimeout` here.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_LINK_MESSAGE_URL,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

const SPACE = SEED_SPACE_ID;

/**
 * Unique per run, so the rooms this spec creates can never collide with a
 * previous run's rows — the appserver is fresh per run, but the names are what
 * the assertions address.
 */
const RUN = newUlid().slice(-6);

/** POST one event batch to `sendEvents` as the test user — the real write path. */
async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Did": TEST_USER_DID },
      body: JSON.stringify({ spaceId: SPACE, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

/** Create a channel through the write path, returning its room id. */
async function createChannel(name: string): Promise<string> {
  const roomId = newUlid();
  await sendEvents([
    { id: roomId, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name },
  ]);
  return roomId;
}

/**
 * Create a thread canonically linked from `parentRoomId`, returning its id.
 *
 * The link travels in its own batch: a room and anything referencing it in one
 * batch is rejected, which is why the client's own `createThread` sends the
 * room first and the link second.
 */
async function createThreadRoom(parentRoomId: string, name: string): Promise<string> {
  const threadId = newUlid();
  await sendEvents([
    { id: threadId, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.thread", name },
  ]);
  await sendEvents([
    {
      id: newUlid(),
      room: parentRoomId,
      $type: "space.roomy.link.createRoomLink.v0",
      linkToRoom: threadId,
      isCreationLink: true,
    },
  ]);
  return threadId;
}

/** Post one plain-text message through the write path. */
async function postMessage(roomId: string, text: string): Promise<void> {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  await sendEvents([
    {
      id: newUlid(),
      room: roomId,
      $type: "space.roomy.message.createMessage.v0",
      body: { mimeType: "text/plain", data: { $bytes: body } },
      extensions: {},
    },
  ]);
}

/** A sidebar row for a room, by its link target. */
function sidebarRow(page: Page, roomId: string) {
  return page.locator(`.sidebar-body-wrap a[href="/${SPACE}/${roomId}"]`);
}

/** A space-index board row for a room. */
function boardRow(page: Page, roomId: string) {
  return page.locator(`.main-panel a.group[href^="/${SPACE}/${roomId}"]`);
}

/**
 * Serve `getFlags` with `links-view` added, before navigation.
 *
 * The seeded world leaves the flag off (as every flag defaults), so this is
 * how the on-branch is reached without a second stack. The real flag body is
 * read once, up front, through the test-mode verifier — a route handler cannot
 * rely on the base fixture's header injection — and a fixed body then fulfils
 * every one of the app's own `getFlags` calls without racing them.
 */
async function withLinksViewEnabled(page: Page): Promise<void> {
  const res = await page.request.get(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags`,
    { headers: { "X-Test-Did": TEST_USER_DID } },
  );
  const { flags = [] } = (await res.json()) as { flags?: string[] };
  const body = { flags: [...flags.filter((f) => f !== "links-view"), "links-view"] };
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags*`,
    (route) => route.fulfill({ json: body }),
  );
}

test.describe("thread rooms", () => {
  test("creating a thread from the composer menu lands in that thread's chat", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    // The first test in the file runs against a cold stack: the appserver's
    // first request pays module init, its DBs' first open, and the profile
    // fetch the user card reads. Measured at 28–32s here, against the helper's
    // 30s default, so this one wait carries explicit headroom.
    await waitForAuthenticated(page, 60_000);
    await expect(composer(page)).toBeVisible();

    const threadName = `thread-${RUN}`;

    // The composer's plus menu is the entry point; "Create Thread" puts the
    // composer into threading mode rather than creating anything yet.
    await page.getByLabel("Actions").click();
    await page.getByRole("menuitem", { name: "Create Thread" }).click();

    // Threading mode replaces the composer with the thread's name field, which
    // starts at the placeholder name.
    const nameField = page.locator("#thread-name");
    await expect(nameField).toHaveValue("Thread");
    await nameField.fill(threadName);

    await page.getByRole("button", { name: "Create Thread" }).click();

    // Creating the thread writes a room and links it from this channel, then
    // navigates into it. The URL is the proof of both: a room id that is not
    // this channel, carrying this channel as its parent.
    await expect(page).toHaveURL(
      new RegExp(`/${SPACE}/[0-9A-HJKMNP-TV-Z]{26}\\?parent=${SEED_ROOM_ID}$`),
    );

    // It renders as a room with a timeline (empty — the menu path creates the
    // thread with nothing forwarded into it).
    await expect(composer(page)).toBeVisible();
    await expect(
      page.getByText("No messages here yet. This is the beginning of something beautiful."),
    ).toBeVisible();

    // And as a THREAD: the navbar breadcrumb names the parent channel, which
    // is only derivable from the canonical link the creation wrote. `:visible`
    // because the breadcrumb renders twice — an ellipsis-and-caret form for
    // narrow containers and the channel name for wide ones — and only the
    // latter carries the name.
    await expect(
      page.locator(`.main-panel a[href="/${SPACE}/${SEED_ROOM_ID}"]:visible`),
    ).toContainText(SEED_ROOM_NAME);
  });
});

test.describe("channel tabs", () => {
  test("a channel offers Chat and Threads, and the tab swaps the surface", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const chatTab = page.locator('.main-panel a[href="#chat"]');
    const threadsTab = page.locator('.main-panel a[href="#threads"]');
    await expect(chatTab).toBeVisible();
    await expect(threadsTab).toBeVisible();
    // The Links tab is flag-gated and the flag is off in the seeded world, so
    // the tab is absent rather than present-and-inert.
    await expect(page.locator('.main-panel a[href="#links"]')).toHaveCount(0);

    // Chat is where the room opens: the timeline and composer are mounted.
    await expect(chatTab).toHaveAttribute("data-state", "active");
    await expect(composer(page)).toBeVisible();

    await threadsTab.click();

    // The tab is not a CSS class on a wrapper alone: the chat surface is torn
    // down (the composer is conditionally mounted) and the board takes over.
    await expect(threadsTab).toHaveAttribute("data-state", "active");
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator(".main-panel ol").first()).toBeHidden();

    await chatTab.click();

    // And back: the composer returns and the channel's messages render again,
    // so the switch is a round trip rather than a one-way teardown.
    await expect(composer(page)).toBeVisible();
    await expect(page.getByText(SEED_MESSAGE_TEXT)).toBeVisible();
  });

  test("the Links tab appears under links-view and lists the room's shared link", async ({
    page,
  }) => {
    await withLinksViewEnabled(page);
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const linksTab = page.locator('.main-panel a[href="#links"]');
    await expect(linksTab).toBeVisible();
    await linksTab.click();
    await expect(linksTab).toHaveAttribute("data-state", "active");
    await expect(composer(page)).toHaveCount(0);

    // The seeded message's link is in the room's link index, so the tab is
    // showing an index rather than an always-empty shell. `:visible` because
    // the chat tab (hidden, not unmounted) still holds the message's own
    // anchor for the same URL.
    const card = page.locator(`a[href="${SEED_LINK_MESSAGE_URL}"]:visible`);
    await expect(card).toBeVisible();
    // The card falls back to the URL's host when the enricher has no data —
    // which is the state a `.invalid` host is in, so this pins that the row
    // rendered from the shared URL rather than from embed metadata.
    await expect(card).toContainText("semble-card.invalid");
  });
});

test.describe("space index board", () => {
  test("lists the space's rooms with activity, newest first, and their channels", async ({
    page,
  }) => {
    // Written before the first load, so the board's first fetch sees them.
    const idleRoom = await createChannel(`board-idle-${RUN}`);
    const activeRoom = await createChannel(`board-active-${RUN}`);
    const activeText = `board activity ${RUN}`;
    await postMessage(activeRoom, activeText);
    const threadName = `board-thread-${RUN}`;
    const threadId = await createThreadRoom(activeRoom, threadName);
    await postMessage(threadId, `board thread activity ${RUN}`);

    await page.goto(`/${SPACE}`);
    await waitForAuthenticated(page);

    // The seeded channel is listed — the board is an index of the space's
    // rooms, not a shell that merely renders.
    const seededRow = boardRow(page, SEED_ROOM_ID);
    await expect(seededRow).toHaveCount(1);
    await expect(seededRow).toContainText(SEED_ROOM_NAME);

    // A thread is listed too, and its row names the channel it hangs off —
    // the two facts the board's channel column exists to carry.
    const threadRow = boardRow(page, threadId);
    await expect(threadRow).toHaveCount(1);
    await expect(threadRow).toContainText(threadName);
    await expect(threadRow).toContainText(`board-active-${RUN}`);

    // A channel's row carries its latest message as a preview, so the board
    // reports what happened, not just which rooms exist.
    const activeRow = boardRow(page, activeRoom);
    await expect(activeRow).toHaveCount(1);
    await expect(activeRow).toContainText(activeText);

    // Ordering is by latest activity: the thread whose message was posted
    // last sits above a room that has no messages at all. Read as positions
    // within the rendered list rather than as first/last, so the assertion
    // holds however many other rooms the shared space has accumulated.
    const hrefs = await page
      .locator(".main-panel a.group")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("href")));
    const ordered = (roomId: string) => hrefs.indexOf(`/${SPACE}/${roomId}`);
    expect(ordered(threadId)).toBeGreaterThanOrEqual(0);
    expect(ordered(idleRoom)).toBeGreaterThanOrEqual(0);
    expect(ordered(threadId)).toBeLessThan(ordered(idleRoom));
  });
});

test.describe("unread indicators", () => {
  test("a message in a room the reader is not viewing marks its sidebar row", async ({
    page,
  }) => {
    const roomId = await createChannel(`unread-${RUN}`);
    await postMessage(roomId, `seen before the reader arrives ${RUN}`);

    // Opening the space's index reads the sidebar, which is what anchors this
    // reader's watermark for the room: nothing is unread until something is
    // posted after it.
    await page.goto(`/${SPACE}`);
    await waitForAuthenticated(page);

    const row = sidebarRow(page, roomId);
    await expect(row).toContainText(`unread-${RUN}`);
    const dot = row.locator('[aria-label="Has unread messages"]');
    await expect(dot).toHaveCount(0);

    // Traffic in a room the reader is NOT viewing arrives as a diff frame; the
    // sidebar has to move on it rather than on a refetch.
    await postMessage(roomId, `posted while the reader is elsewhere ${RUN}`);
    await expect(dot).toHaveCount(1);

    // Reading the room clears it again — the same round trip the badge exists
    // to express.
    await row.click();
    await expect(composer(page)).toBeVisible();
    await expect(dot).toHaveCount(0);
  });

  test("the space index board marks that room unread from the stored read position", async ({
    page,
  }) => {
    const roomId = await createChannel(`board-unread-${RUN}`);
    await postMessage(roomId, `read up to here ${RUN}`);

    await page.goto(`/${SPACE}`);
    await waitForAuthenticated(page);
    await expect(boardRow(page, roomId)).toContainText(`board-unread-${RUN}`);

    await postMessage(roomId, `unseen on the board ${RUN}`);

    // Reloaded, so the marker can only come from the appserver's own unread
    // computation against the stored watermark — not from a diff frame.
    await page.reload();
    await waitForAuthenticated(page);

    const row = boardRow(page, roomId);
    await expect(row.locator('[aria-label="Unread"]').first()).toBeVisible();
    await expect(
      sidebarRow(page, roomId).locator('[aria-label="Has unread messages"]'),
    ).toHaveCount(1);
  });
});
