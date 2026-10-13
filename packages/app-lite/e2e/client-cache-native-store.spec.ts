/**
 * The shell's cache lives in the shell, not in the webview.
 *
 * P3's claim, end to end: inside a Tauri shell the app persists its query cache
 * through the store plugin's native file, and a reload paints the room from
 * that file — and a shell with no store at all degrades to `localStorage`,
 * never to the webview's IndexedDB, which is the thing the native store exists
 * to avoid (§4.1).
 *
 * The shell itself is stubbed at the IPC boundary it actually calls — see
 * `native-store.ts` for why the real Rust build is not in this loop, and what
 * covers it instead. Everything above that boundary is the shipped code path:
 * the bundled plugin JS, `TauriStorePersister`, and the selection in
 * `cache-store.ts`.
 */
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { installGate } from "./held-requests.ts";
import {
  installNativeStore,
  nativeSnapshotEntryCount,
} from "./native-store.ts";
import { SEED_MESSAGE_TEXT, SEED_ROOM_PATH } from "./fixtures.ts";

/** The app's IndexedDB database, which a shell must never open. */
const WEB_CACHE_DATABASE = "roomy-query-cache";
/** The app's `localStorage` key, the shell's fallback when it has no store. */
const WEB_CACHE_KEY = "roomy-query-cache";

test.describe("the shell's native store", () => {
  test("the cache is written to it, and a reload restores from it", async ({
    page,
  }) => {
    await installNativeStore(page);
    const gate = installGate(page);
    await gate.install;

    // First visit: the page fetches and the (throttled) write lands in the
    // shell's store.
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page, 120_000);
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });

    await expect
      .poll(() => nativeSnapshotEntryCount(page), {
        timeout: 30_000,
        message: "snapshot written to the shell's store",
      })
      .toBeGreaterThan(0);

    // The store is the shell's, so the webview's own database is never opened.
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    );
    expect(databases).not.toContain(WEB_CACHE_DATABASE);

    // Freeze the read path and reload: anything on screen now can only have
    // come from the shell's store, since the stub's contents outlive the page.
    gate.stall(true);
    await page.reload();
    await waitForAuthenticated(page, 120_000);

    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });
    // ...and the restore invalidated the key it hydrated, so the mount did
    // start the refetch the gate is holding.
    await expect
      .poll(() => gate.heldCount(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    gate.releaseAll();
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT);
  });

  test("a shell whose store cannot be opened falls back to localStorage", async ({
    page,
  }) => {
    // A shell built without the plugin: the global is there, the store is not.
    // This is the §4.3 case that must degrade to an empty cache that fetches,
    // not to an exception on the way to a view.
    await installNativeStore(page, { failOpen: true });

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page, 120_000);
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });

    await expect
      .poll(
        () =>
          page.evaluate((key) => localStorage.getItem(key), WEB_CACHE_KEY),
        { timeout: 30_000, message: "snapshot written to localStorage" },
      )
      .toBeTruthy();

    // The fallback is the web store, not the webview's IndexedDB.
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    );
    expect(databases).not.toContain(WEB_CACHE_DATABASE);
  });
});
