/**
 * Voice room rendering, with no LiveKit deployment and no media.
 *
 * The appserver in the E2E stack has no `LIVEKIT_*` env, so it is in exactly
 * the state the degraded path exists for: every voice RPC answers empty or
 * null. These tests pin what the client does in that state — it renders the
 * voice room, and it fabricates no call state it cannot have.
 *
 * The media path itself (WebRTC, E2EE, capture) has no automated coverage:
 * there is no SFU in CI and no browser microphone. `VoiceCallState` is
 * covered against a mocked `livekit-client` in `src/lib/voice`, which is what
 * those unit tests are for; see `docs/plans/voice-chat-plan.md` §6.3–6.4.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_SPACE_ID,
  SEED_VOICE_ROOM_NAME,
  SEED_VOICE_ROOM_PATH,
} from "./fixtures.ts";

test.describe("voice room", () => {
  test("the sidebar lists the voice room under its own heading", async ({ page }) => {
    // Straight to the space: the space's own index route mounts the sidebar,
    // so the test does not depend on the home page's space switcher.
    await page.goto(`/${SEED_SPACE_ID}`);
    await waitForAuthenticated(page);


    // The voice room is not a category child, so it appears under the
    // sidebar's "Voice" heading rather than in the channel tree.
    await expect(page.getByText("Voice", { exact: true })).toBeVisible();

    const voiceLink = page.locator(`a[href="${SEED_VOICE_ROOM_PATH}"]`);
    await expect(voiceLink).toBeVisible();
    await expect(voiceLink).toContainText(SEED_VOICE_ROOM_NAME);
    // The room carries the voice icon, not the channel hashtag — that is what
    // distinguishes a voice room at a glance in the sidebar.
    await expect(voiceLink.getByLabel("Voice room")).toBeVisible();
  });

  test("opening a voice room renders the call panel, not a message timeline", async ({
    page,
  }) => {
    await page.goto(SEED_VOICE_ROOM_PATH);
    await waitForAuthenticated(page);

    await expect(page.getByRole("heading", { name: "Voice room" })).toBeVisible();
    await expect(page.getByText("No one is in the call right now.")).toBeVisible();

    // No composer: a voice room has no timeline to post to.
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });

  test("an unconfigured deployment reports no call rather than a broken one", async ({
    page,
  }) => {
    await page.goto(SEED_VOICE_ROOM_PATH);
    await waitForAuthenticated(page);

    await expect(page.getByRole("heading", { name: "Voice room" })).toBeVisible();
    // The appserver has no LiveKit configured, so `getToken` answers all-null
    // and `getParticipants` answers empty. Nothing connected, so no
    // participant list is rendered and no connection error is reported: the
    // client's degraded path is an absence, not a failure.
    await expect(page.getByText("In this call")).toHaveCount(0);
    await expect(page.getByText(/could not be reached|not supported here/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Join call" })).toBeVisible();
  });
});
