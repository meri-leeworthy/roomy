/**
 * The Tauri shell, as far as the app can tell, for a headless run.
 *
 * The native-store path cannot be driven by a real Tauri build here: that needs
 * a full Rust build of the shell plus a WebKit driver, and the assertion that
 * matters — that the app picks the shell's store and round-trips the cache
 * through it — does not need the Rust side. What it needs is the boundary the
 * app actually calls, which is the IPC the plugin's JS crosses.
 *
 * So this installs `window.__TAURI__` (what `isShell()` reads) and a
 * `__TAURI_INTERNALS__.invoke` that answers the `plugin:store|*` commands over a
 * `sessionStorage`-backed map. Everything above that line is real: the bundled
 * `@tauri-apps/plugin-store` JS, `TauriStorePersister`, and the selection in
 * `cache-store.ts` all run unmodified. Only the Rust half is replaced, and the
 * Rust half is what `cargo check` and the generated ACL schema cover.
 *
 * `sessionStorage` rather than a plain in-page object because the store is a
 * *file* in the shell: it has to outlive a reload for the restore to be
 * observable at all.
 */
import type { Page } from "@playwright/test";

/** Key the stub keeps its map under. Distinct from anything the app stores. */
const STUB_KEY = "e2e:native-store";

export interface NativeStoreStubOptions {
  /**
   * Reject every `plugin:store|load`, the way a shell built without the plugin
   * (or with a failing one) does. The app must treat that as no native store.
   */
  failOpen?: boolean;
}

/**
 * Present this page as a Tauri shell with a native store. Applies to every
 * navigation in the page's context, so the stub is in place after a reload too.
 */
export async function installNativeStore(
  page: Page,
  opts: NativeStoreStubOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, failOpen }) => {
      /** The whole store's contents. Parsed from the stub's own JSON. */
      const read = (): Record<string, unknown> => {
        const raw = sessionStorage.getItem(key);
        if (raw === null) return {};
        const parsed: unknown = JSON.parse(raw);
        // Written only by `persist` below, which writes a JSON object; the
        // cast is the round trip's type, not a claim about foreign input.
        return typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      };
      const persist = (data: Record<string, unknown>): void => {
        sessionStorage.setItem(key, JSON.stringify(data));
      };

      // What `isShell()` reads. Deliberately bare: every other `__TAURI__`
      // consumer in the app (the opener, the updater, native push) probes for
      // its own namespace and no-ops when it is missing, which is the
      // behaviour a shell without those plugins has anyway.
      Object.assign(window, {
        __TAURI__: {},
        __TAURI_INTERNALS__: {
          invoke: async (
            cmd: string,
            args: Record<string, unknown>,
          ): Promise<unknown> => {
            const data = read();
            switch (cmd) {
              case "plugin:store|load":
                if (failOpen) {
                  throw new Error("store plugin is not registered");
                }
                // A resource id. The app never closes it, so any stable value
                // names the one store this stub serves.
                return 1;
              case "plugin:store|get":
              case "plugin:store|set":
              case "plugin:store|delete": {
                // The plugin's JS always passes a string key; narrow rather
                // than assert, so a wrong-shaped call fails loudly instead of
                // addressing the store with `undefined`.
                const storeKey = args["key"];
                if (typeof storeKey !== "string") {
                  throw new Error(
                    `native-store stub: ${cmd} without a string key`,
                  );
                }
                if (cmd === "plugin:store|get") {
                  return [data[storeKey], Object.hasOwn(data, storeKey)];
                }
                if (cmd === "plugin:store|set") {
                  data[storeKey] = args["value"];
                  persist(data);
                  return null;
                }
                const existed = Object.hasOwn(data, storeKey);
                delete data[storeKey];
                persist(data);
                return existed;
              }
              case "plugin:store|save":
                // Writes are persisted as they happen, so there is no buffer
                // for this to flush. The real plugin's `save` is not a no-op.
                return null;
              default:
                throw new Error(`native-store stub: unexpected command ${cmd}`);
            }
          },
        },
      });
    },
    { key: STUB_KEY, failOpen: opts.failOpen ?? false },
  );
}

/** The snapshot the app wrote through the stub store, or null if none yet. */
export async function readNativeSnapshot(page: Page): Promise<unknown> {
  return await page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("roomy-query-cache" in parsed)) return null;
    return parsed["roomy-query-cache"];
  }, STUB_KEY);
}

/**
 * The entry count in the snapshot the app wrote through the stub store. `0`
 * both before the first write and while the store is empty, which is what the
 * poll in the spec wants.
 */
export async function nativeSnapshotEntryCount(page: Page): Promise<number> {
  const snapshot = await readNativeSnapshot(page);
  if (typeof snapshot !== "object" || snapshot === null) return 0;
  if (!("entries" in snapshot)) return 0;
  return Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
}
