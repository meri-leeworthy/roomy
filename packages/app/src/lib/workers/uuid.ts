export function generateUUID(): string {
  // best: native
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto) {
      const c = (globalThis as any).crypto;
      if (typeof c.randomUUID === "function") return c.randomUUID();
      if (typeof c.getRandomValues === "function") {
        const bytes = c.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        return [...bytes]
          .map(
            (b, i) =>
              (i === 4 || i === 6 || i === 8 || i === 10 ? "-" : "") +
              b.toString(16).padStart(2, "0"),
          )
          .join("");
      }
    }
  } catch (e) {
    // fall through to Math.random fallback
  }

  // fallback (not crypto-secure, but functional)
  let d = Date.now();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (d + Math.random() * 16) % 16 | 0;
    d = Math.floor(d / 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
