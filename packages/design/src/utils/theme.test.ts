import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeMode,
  initSystemThemeListener,
  nextThemeMode,
  readThemeMode,
  resolveDark,
  systemPrefersDark,
  writeThemeMode,
} from "./theme.js";

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
}

interface ClassListMock {
  add: (name: string) => void;
  remove: (name: string) => void;
  toggle: (name: string, force?: boolean) => boolean;
  contains: (name: string) => boolean;
}

function makeClassList(): ClassListMock {
  const classes = new Set<string>();
  return {
    add: (name: string) => void classes.add(name),
    remove: (name: string) => void classes.delete(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !classes.has(name);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
    contains: (name: string) => classes.has(name),
  };
}

function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      void listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      void listeners.delete(listener),
    dispatch: (matches: boolean) => {
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    },
  };
  vi.stubGlobal("matchMedia", () => mql);
  vi.stubGlobal("window", {
    matchMedia: () => mql,
    dispatchEvent: (event: Event) => {
      dispatched.push((event as CustomEvent).detail);
    },
  });
  return mql;
}

let storage: Storage;
let classList: ClassListMock;
let dispatched: Array<{ darkMode: boolean; themeMode?: string }>;

beforeEach(() => {
  storage = makeStorage();
  classList = makeClassList();
  dispatched = [];
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: { classList } });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }),
    dispatchEvent: (event: Event) => {
      dispatched.push((event as CustomEvent).detail);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readThemeMode", () => {
  it("defaults to system when nothing is stored", () => {
    expect(readThemeMode()).toBe("system");
  });

  it("migrates legacy boolean values", () => {
    storage.setItem("darkMode", JSON.stringify(true));
    expect(readThemeMode()).toBe("dark");
    storage.setItem("darkMode", JSON.stringify(false));
    expect(readThemeMode()).toBe("light");
  });

  it("reads stored mode strings", () => {
    for (const mode of ["light", "dark", "system"] as const) {
      storage.setItem("darkMode", JSON.stringify(mode));
      expect(readThemeMode()).toBe(mode);
    }
  });

  it("falls back to system for invalid values", () => {
    storage.setItem("darkMode", JSON.stringify("neon"));
    expect(readThemeMode()).toBe("system");
    storage.setItem("darkMode", "not-json");
    expect(readThemeMode()).toBe("system");
  });
});

describe("writeThemeMode", () => {
  it("persists the mode as a JSON string", () => {
    writeThemeMode("dark");
    expect(storage.getItem("darkMode")).toBe(JSON.stringify("dark"));
    expect(readThemeMode()).toBe("dark");
  });
});

describe("nextThemeMode", () => {
  it("cycles light → dark → system → light", () => {
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
    expect(nextThemeMode("system")).toBe("light");
  });
});

describe("systemPrefersDark", () => {
  it("reports the OS preference", () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    stubMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
  });
});

describe("resolveDark", () => {
  it("resolves explicit modes regardless of OS preference", () => {
    stubMatchMedia(true);
    expect(resolveDark("dark")).toBe(true);
    expect(resolveDark("light")).toBe(false);
    stubMatchMedia(false);
    expect(resolveDark("dark")).toBe(true);
    expect(resolveDark("light")).toBe(false);
  });

  it("follows the OS preference in system mode", () => {
    stubMatchMedia(true);
    expect(resolveDark("system")).toBe(true);
    stubMatchMedia(false);
    expect(resolveDark("system")).toBe(false);
  });
});

describe("applyThemeMode", () => {
  it("toggles the dark class, persists, and dispatches", () => {
    stubMatchMedia(false);
    applyThemeMode("dark");
    expect(classList.contains("dark")).toBe(true);
    expect(storage.getItem("darkMode")).toBe(JSON.stringify("dark"));
    expect(dispatched).toEqual([{ darkMode: true, themeMode: "dark" }]);

    applyThemeMode("light");
    expect(classList.contains("dark")).toBe(false);
    expect(dispatched.at(-1)).toEqual({ darkMode: false, themeMode: "light" });
  });

  it("resolves system mode against the OS preference", () => {
    stubMatchMedia(true);
    applyThemeMode("system");
    expect(classList.contains("dark")).toBe(true);
    expect(dispatched.at(-1)).toEqual({ darkMode: true, themeMode: "system" });
  });
});

describe("initSystemThemeListener", () => {
  it("re-applies the dark class when the OS preference changes in system mode", () => {
    const mql = stubMatchMedia(false);
    applyThemeMode("system");
    expect(classList.contains("dark")).toBe(false);

    const cleanup = initSystemThemeListener();
    mql.dispatch(true);
    expect(classList.contains("dark")).toBe(true);
    expect(dispatched.at(-1)).toEqual({ darkMode: true, themeMode: "system" });

    cleanup();
    mql.dispatch(false);
    expect(classList.contains("dark")).toBe(true);
  });

  it("ignores OS changes when the mode is explicit", () => {
    const mql = stubMatchMedia(false);
    applyThemeMode("light");
    const cleanup = initSystemThemeListener();
    mql.dispatch(true);
    expect(classList.contains("dark")).toBe(false);
    cleanup();
  });
});
