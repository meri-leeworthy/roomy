/**
 * A blocked author on the two surfaces that do not render the room timeline:
 * search results and the activity feed.
 *
 * The block is written the way a user writes one — the profile page's Block
 * action, through the client's own repo scope — and `refreshBlocks` is called
 * so the appserver notices immediately. Every read below is the real stack's
 * answer.
 *
 * Neither surface offers a reveal: the affordance lives on the timeline's
 * `MessageBubble` alone, and both redact an author by DID for every caller, so
 * an admin of the space sees exactly what an ordinary member does. The spec
 * asserts the reveal control is absent for that reason.
 *
 * Message search is Qdrant-backed, and this hermetic stack runs no Qdrant
 * (`launch-stack.ts` leaves it unconfigured, so the endpoint answers 503 — the
 * graceful degradation `search.spec.ts` documents). The search-messages
 * response is therefore served from the appserver's own `room.getMessages`
 * output for the two hit rooms, mapped into the search-hit shape: the block
 * and the redaction inside those rows are the real server's, and only the
 * ranking is absent.
 */

import type { Page } from "@playwright/test";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import { SCOPE_SETS } from "../src/lib/scopes.ts";
import { expect, messageList, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  OTHER_USER_DID,
  OTHER_USER_DISPLAY_NAME,
  OTHER_USER_HANDLE,
  PDS_ORIGIN,
  SEED_MEMBER_SPACE_ID,
  SEED_MEMBER_SPACE_MESSAGE_TEXT,
  SEED_MEMBER_SPACE_ROOM_ID,
  SEED_MEMBER_SPACE_ROOM_PATH,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_SPACE_3_ID,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_NAME,
  SEED_SPACE_3_ROOM_ID,
  SEED_SPACE_3_ROOM_NAME,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
  TEST_ADMIN_DID,
  TEST_USER_DID,
} from "./fixtures.ts";

const BLOCK_COLLECTION = "space.roomy.user.block";
/** The third space's message is authored by this account. */
const AUTHOR_PROFILE_PATH = `/user/${OTHER_USER_DID}`;
/** The member space's message is authored by this account. */
const MEMBER_AUTHOR_PROFILE_PATH = `/user/${TEST_ADMIN_DID}`;
/** The body of the reply the reply-preview case posts for itself. */
const REPLY_TEXT = "a reply into a blocked author's message";
/** The body the feed case posts as its unblocked author's positive control. */
const FEED_CONTROL_TEXT = "a message from an author the viewer has not blocked";
/** Rich-text bodies ride the wire base64-encoded, as `Message` documents. */
const RICHTEXT_MIME = "application/vnd.roomy.richtext+json";

/** A block rkey is a TID: 13 chars, first char never 0/1, no `l`/`o`/`u`. */
const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** One message row as `room.getMessages` returns it. */
interface MessageRow {
  id: string;
  content: string;
  mimeType?: string;
  authorName?: string;
  blocked?: boolean;
  [key: string]: unknown;
}

/** One search hit: a message row plus the room/space context search adds. */
type SearchHit = MessageRow & {
  roomId: string;
  spaceId: string;
  spaceName: string;
  roomName: string;
  roomKind: string;
  replyTo?: string;
  reply?: { messageId: string; message: MessageRow };
};

/** The plaintext of a message body, decoding the base64 rich-text document. */
function plaintext(row: MessageRow): string {
  if (row.mimeType !== RICHTEXT_MIME) return row.content;
  try {
    const doc = JSON.parse(
      Buffer.from(row.content, "base64").toString("utf8"),
    ) as { blocks?: { text?: string }[] };
    return (doc.blocks ?? []).map((b) => b.text ?? "").join("");
  } catch {
    return "";
  }
}

/** Read `roomId`'s messages through the appserver, as the seeded user. */
async function roomMessages(page: Page, roomId: string): Promise<MessageRow[]> {
  const res = await page.request.get(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.room.getMessages`,
    {
      params: { roomId, limit: "50" },
      headers: { "X-Test-Did": TEST_USER_DID },
    },
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { messages: MessageRow[] };
  return body.messages;
}

/** The id of the seeded message carrying `text`, while it is not redacted. */
async function messageIdByText(
  page: Page,
  roomId: string,
  text: string,
): Promise<string> {
  const found = (await roomMessages(page, roomId)).find(
    (m) => plaintext(m) === text,
  );
  if (!found) throw new Error(`no seeded message "${text}" in ${roomId}`);
  return found.id;
}

/** Build a search hit for one message, as the search endpoint returns it. */
async function searchHit(
  page: Page,
  roomId: string,
  spaceId: string,
  spaceName: string,
  roomName: string,
  messageId: string,
): Promise<SearchHit> {
  const found = (await roomMessages(page, roomId)).find(
    (m) => m.id === messageId,
  );
  if (!found) throw new Error(`no message ${messageId} in ${roomId}`);
  return {
    ...found,
    roomId,
    spaceId,
    spaceName,
    roomName,
    roomKind: "channel",
  } as SearchHit;
}

/** Read the seeded user's block records from the stub PDS. */
async function listBlocks(
  page: Page,
): Promise<{ uri: string; subject: unknown }[]> {
  const res = await page.request.get(
    `${PDS_ORIGIN}/xrpc/com.atproto.repo.listRecords`,
    { params: { repo: TEST_USER_DID, collection: BLOCK_COLLECTION } },
  );
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    records: { uri: string; value: { subject?: unknown } }[];
  };
  return body.records.map((r) => ({ uri: r.uri, subject: r.value.subject }));
}

/**
 * Remove any block already in the user's repo. The stack is one process for the
 * whole run, so a previous test's block is still there; the block a test writes
 * has to be the only one that can account for its result.
 */
async function clearBlocks(page: Page): Promise<void> {
  for (const record of await listBlocks(page)) {
    const res = await page.request.post(
      `${PDS_ORIGIN}/xrpc/com.atproto.repo.deleteRecord`,
      {
        data: {
          repo: TEST_USER_DID,
          collection: BLOCK_COLLECTION,
          rkey: record.uri.split("/").pop(),
        },
      },
    );
    expect(res.ok()).toBe(true);
  }
}

/**
 * Re-read the caller's blocks on the appserver, so a block or unblock takes
 * effect on the next read instead of at the appserver's cache expiry. The
 * profile page's write path fires this in the background; the spec calls it
 * directly so the reads below are deterministic.
 */
async function refreshBlocks(page: Page, subject?: string): Promise<void> {
  const res = await page.request.post(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.user.refreshBlocks`,
    {
      headers: { "X-Test-Did": TEST_USER_DID },
      data: subject ? { subject } : {},
    },
  );
  expect(res.ok()).toBe(true);
}

/**
 * The scope the stub PDS authorizes repo writes against — the session's grant,
 * which a real consent round-trip would have set. `blocks` is not in the base
 * tier the test session holds, so the write is refused until a spec widens it.
 */
async function setGrantedScope(page: Page, scope: string): Promise<void> {
  const res = await page.request.post(`${PDS_ORIGIN}/__e2e/granted-scope`, {
    data: { scope },
  });
  expect(res.ok()).toBe(true);
}

/**
 * Drop this caller's cached activity-feed pages.
 *
 * A block write changes what the feed may hold but emits no invalidation
 * signal (`getActivityFeed` is response-cached by the appserver), so a page
 * fetched while blocked would be served for the cache's whole TTL. Marking a
 * room seen is the app's own caller-scoped feed invalidation — the call the
 * room page makes when it opens — and it forces the next feed read to
 * recompute.
 */
async function dropFeedCache(page: Page): Promise<void> {
  const res = await page.request.post(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.room.updateSeen`,
    {
      headers: { "X-Test-Did": TEST_USER_DID },
      data: { roomId: SEED_ROOM_ID },
    },
  );
  expect(res.ok()).toBe(true);
}

/** Leave the caller with no block of the seeded author, server-side included. */
async function unblock(page: Page): Promise<void> {
  await clearBlocks(page);
  await refreshBlocks(page);
}

/** Block `subjectDid` through their profile page, then refresh the server. */
async function blockAuthor(
  page: Page,
  subjectDid: string = OTHER_USER_DID,
  profilePath: string = AUTHOR_PROFILE_PATH,
): Promise<void> {
  await unblock(page);
  await setGrantedScope(page, SCOPE_SETS.blocks);

  await page.goto(profilePath);
  // The profile page's readiness gate: the auth bootstrap has to land before
  // the Block action can render.
  await waitForAuthenticated(page);
  await expect(blockButton(page)).toBeVisible({ timeout: 30_000 });
  await blockButton(page).click();
  await expect(unblockButton(page)).toBeVisible();

  const records = await listBlocks(page);
  expect(records).toHaveLength(1);
  expect(records[0]?.subject).toBe(subjectDid);
  expect(records[0]?.uri.split("/").pop() ?? "").toMatch(TID_PATTERN);

  await refreshBlocks(page, subjectDid);
}

/**
 * Post one message through the real write path, as the test user. A spec
 * writes the rows its own controls read rather than the shared seed, so no
 * other spec's message counts in those rooms move and the row is the newest
 * in its room whatever the rest of the suite left behind.
 */
async function postMessage(opts: {
  spaceId: string;
  roomId: string;
  text: string;
  replyTo?: string;
}): Promise<void> {
  const serialized = serializeBlocks([
    { $type: "space.roomy.richtext.blocks#text", text: opts.text },
  ]);
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({
        spaceId: opts.spaceId,
        events: [
          {
            id: newUlid(),
            room: opts.roomId,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: serialized.mimeType,
              data: { $bytes: Buffer.from(serialized.data).toString("base64") },
            },
            extensions: opts.replyTo
              ? {
                  "space.roomy.extension.attachments.v0": {
                    $type: "space.roomy.extension.attachments.v0",
                    attachments: [
                      {
                        $type: "space.roomy.attachment.reply.v0",
                        target: opts.replyTo,
                      },
                    ],
                  },
                }
              : {},
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

const blockButton = (page: Page) =>
  page.getByRole("button", { name: "Block this user" });
const unblockButton = (page: Page) =>
  page.getByRole("button", { name: "Unblock this user" });

test.describe("a blocked author outside the timeline", () => {
  test("search results render no body, name or avatar for the blocked author", async ({
    page,
  }) => {
    await unblock(page);
    // Discover the ids while the authors are still visible; the tombstone that
    // replaces the blocked row carries no text to match on.
    const blockedId = await messageIdByText(
      page,
      SEED_SPACE_3_ROOM_ID,
      SEED_SPACE_3_MESSAGE_TEXT,
    );
    const controlId = await messageIdByText(
      page,
      SEED_ROOM_ID,
      SEED_MESSAGE_TEXT,
    );

    await blockAuthor(page);

    const blockedHit = await searchHit(
      page,
      SEED_SPACE_3_ROOM_ID,
      SEED_SPACE_3_ID,
      SEED_SPACE_3_NAME,
      SEED_SPACE_3_ROOM_NAME,
      blockedId,
    );
    expect(blockedHit.blocked).toBe(true);

    // The control hit is an ordinary message that replies into the blocked one,
    // so the duplicated preview markup renders behind a hidden author too.
    const controlHit = await searchHit(
      page,
      SEED_ROOM_ID,
      SEED_SPACE_ID,
      SEED_SPACE_NAME,
      SEED_ROOM_NAME,
      controlId,
    );
    expect(controlHit.blocked).toBeUndefined();
    controlHit.replyTo = blockedId;
    controlHit.reply = { messageId: blockedId, message: blockedHit };

    await page.route(
      `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.search.messages*`,
      (route) => route.fulfill({ json: { messages: [blockedHit, controlHit] } }),
    );

    await page.goto("/search?q=seeded");
    await waitForAuthenticated(page);

    const results = page.locator("main");
    await expect(results.getByText("Messages", { exact: true })).toBeVisible();

    // The blocked hit keeps its place and renders the indicator alone: no
    // body, no name, no author link.
    await expect(
      results.locator('[data-testid="blocked-indicator"]'),
    ).toHaveCount(1);
    await expect(results).not.toContainText(SEED_SPACE_3_MESSAGE_TEXT);
    await expect(results).not.toContainText(
      /E2E Other User|e2e\.other\.roomy\.test/,
    );
    await expect(
      results.locator(`a[href="/user/${OTHER_USER_DID}"]`),
    ).toHaveCount(0);

    // The reply preview into the blocked message is redacted the same way.
    await expect(
      results.locator('[data-testid="blocked-preview"]'),
    ).toHaveCount(1);

    // No reveal is offered on this surface, for any caller.
    await expect(page.locator('[data-testid="reveal-blocked"]')).toHaveCount(0);

    // Positive control: the non-blocked author's hit renders in full, with its
    // identity (whichever of name/handle resolved).
    await expect(results).toContainText(SEED_MESSAGE_TEXT);
    await expect(results).toContainText(/E2E Tester|e2e\.roomy\.test/);
  });

  test("the activity feed renders no body, name or avatar for the blocked author", async ({
    page,
  }) => {
    await blockAuthor(page);
    // The positive control is a message this spec posts to the seeded room, so
    // it is that room's newest row no matter which rooms the rest of the suite
    // left most recently active.
    await postMessage({
      spaceId: SEED_SPACE_ID,
      roomId: SEED_ROOM_ID,
      text: FEED_CONTROL_TEXT,
    });
    await dropFeedCache(page);

    await page.goto("/");
    await waitForAuthenticated(page);

    const feed = page.locator("main");
    await expect(feed).toContainText("Recent Activity");

    // The room keeps its header — a feed item whose messages all vanish still
    // renders — but the blocked author's message is gone, body and identity
    // alike.
    await expect(feed).toContainText(`#${SEED_SPACE_3_ROOM_NAME}`);
    await expect(feed).not.toContainText(SEED_SPACE_3_MESSAGE_TEXT);
    await expect(feed).not.toContainText(OTHER_USER_DISPLAY_NAME);
    await expect(feed).not.toContainText(OTHER_USER_HANDLE);
    await expect(page.locator('[data-testid="reveal-blocked"]')).toHaveCount(0);

    // Positive control: the non-blocked author's message still renders, with
    // its identity (the feed shows whichever of name/handle resolved).
    await expect(feed).toContainText(FEED_CONTROL_TEXT);
    await expect(feed).toContainText(/E2E Tester|e2e\.roomy\.test/);
  });

  test("the unblocked author renders in full on the feed", async ({ page }) => {
    await unblock(page);
    await dropFeedCache(page);

    await page.goto("/");
    await waitForAuthenticated(page);

    const feed = page.locator("main");
    await expect(feed).toContainText(SEED_SPACE_3_MESSAGE_TEXT);
    await expect(feed).toContainText(/E2E Other User|e2e\.other\.roomy\.test/);
  });

  test("a reply preview into a blocked message renders the indicator", async ({
    page,
  }) => {
    await unblock(page);
    // The reply target is read while the author is still visible: the
    // tombstone carries no text to match on.
    const targetId = await messageIdByText(
      page,
      SEED_MEMBER_SPACE_ROOM_ID,
      SEED_MEMBER_SPACE_MESSAGE_TEXT,
    );
    await postMessage({
      spaceId: SEED_MEMBER_SPACE_ID,
      roomId: SEED_MEMBER_SPACE_ROOM_ID,
      text: REPLY_TEXT,
      replyTo: targetId,
    });
    await blockAuthor(page, TEST_ADMIN_DID, MEMBER_AUTHOR_PROFILE_PATH);

    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);

    // The room renders its timeline as an ordered list (`ChatArea`), not a
    // `main` region.
    const room = messageList(page);
    // The reply is still a message the viewer can read...
    await expect(room).toContainText(REPLY_TEXT);
    // ...but its preview of the blocked target is the indicator alone: no
    // author, no profile link, no snippet. The stack is shared across a
    // retry, so a previous attempt's reply may still be on screen.
    await expect(
      room.locator('[data-testid="blocked-preview"]').first(),
    ).toBeVisible();
    await expect(
      room.locator(`a[href="/user/${TEST_ADMIN_DID}"]`),
    ).toHaveCount(0);
    await expect(room).not.toContainText(SEED_MEMBER_SPACE_MESSAGE_TEXT);

    // The suite shares one stack, and a block this spec leaves behind is a
    // block the next spec reads off the stub PDS.
    await unblock(page);
  });
});
