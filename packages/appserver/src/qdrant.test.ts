/**
 * Unit tests for the Qdrant config singleton (src/qdrant.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getQdrantConfig } from "./qdrant.ts";

const SAVED_URL = process.env.QDRANT_URL;
const SAVED_KEY = process.env.QDRANT_API_KEY;

afterEach(() => {
  if (SAVED_URL === undefined) delete process.env.QDRANT_URL;
  else process.env.QDRANT_URL = SAVED_URL;
  if (SAVED_KEY === undefined) delete process.env.QDRANT_API_KEY;
  else process.env.QDRANT_API_KEY = SAVED_KEY;
});

describe("getQdrantConfig", () => {
  test("returns null when QDRANT_URL is unset", () => {
    delete process.env.QDRANT_URL;
    expect(getQdrantConfig()).toBeNull();
  });

  test("parses url + optional api key, stripping trailing slashes", () => {
    process.env.QDRANT_URL = "https://search-staging.roomy.space///";
    process.env.QDRANT_API_KEY = "secret";
    expect(getQdrantConfig()).toEqual({
      url: "https://search-staging.roomy.space",
      port: 443,
      apiKey: "secret",
    });

    delete process.env.QDRANT_API_KEY;
    expect(getQdrantConfig()).toEqual({
      url: "https://search-staging.roomy.space",
      port: 443,
    });
  });

  test("treats a protocol-less URL as disabled (not a crash)", () => {
    process.env.QDRANT_URL = "search-staging.roomy.space";
    expect(getQdrantConfig()).toBeNull();
  });

  test("normalizes https URLs without a port to port 443 (client defaults to 6333)", () => {
    process.env.QDRANT_URL = "https://search-staging.roomy.space";
    expect(getQdrantConfig()?.url).toBe("https://search-staging.roomy.space");
    expect(getQdrantConfig()?.port).toBe(443);
  });

  test("keeps an explicit port", () => {
    process.env.QDRANT_URL = "https://search-staging.roomy.space:6333";
    expect(getQdrantConfig()?.url).toBe("https://search-staging.roomy.space:6333");
    expect(getQdrantConfig()?.port).toBe(6333);
  });

  test("http internal URLs keep no port (client defaults to 6333)", () => {
    process.env.QDRANT_URL = "http://qdrant.railway.internal";
    expect(getQdrantConfig()?.url).toBe("http://qdrant.railway.internal");
    expect(getQdrantConfig()?.port).toBeUndefined();
  });
});
