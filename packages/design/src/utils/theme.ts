/**
 * Tri-state theme mode: explicit light/dark, or follow the OS preference.
 *
 * Persisted under the legacy `darkMode` localStorage key so existing users
 * keep their choice. The legacy format stored JSON-encoded booleans
 * (`"true"`/`"false"`); the new format stores JSON-encoded mode strings
 * (`"light"`/`"dark"`/`"system"`). `readThemeMode` migrates both.
 */

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "darkMode";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const MODES = ["light", "dark", "system"] as const;

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function getStorage(): Storage | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

/** Read the persisted theme mode, migrating the legacy boolean format. */
export function readThemeMode(): ThemeMode {
  const storage = getStorage();
  if (!storage) return "system";
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null) return "system";
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed === true) return "dark";
    if (parsed === false) return "light";
    if (isThemeMode(parsed)) return parsed;
  } catch {
    // fall through to system
  }
  return "system";
}

/** Persist the theme mode. */
export function writeThemeMode(mode: ThemeMode): void {
  getStorage()?.setItem(STORAGE_KEY, JSON.stringify(mode));
}

/** Whether the OS currently prefers dark. */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

/** Resolve a mode to the effective dark flag. */
export function resolveDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

/** Cycle light → dark → system → light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "light") return "dark";
  if (mode === "dark") return "system";
  return "light";
}

/** Apply a mode: toggle the `dark` class, persist, and notify listeners. */
export function applyThemeMode(mode: ThemeMode): void {
  const dark = resolveDark(mode);
  document.documentElement.classList.toggle("dark", dark);
  writeThemeMode(mode);
  window.dispatchEvent(
    new CustomEvent("theme-changed", {
      detail: { darkMode: dark, themeMode: mode },
    }),
  );
}

/**
 * Live-follow the OS preference while the mode is "system".
 * Returns a cleanup function that removes the listener.
 */
export function initSystemThemeListener(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(MEDIA_QUERY);
  const onChange = (event: MediaQueryListEvent) => {
    if (readThemeMode() === "system") {
      document.documentElement.classList.toggle("dark", event.matches);
      window.dispatchEvent(
        new CustomEvent("theme-changed", {
          detail: { darkMode: event.matches, themeMode: "system" },
        }),
      );
    }
  };
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
