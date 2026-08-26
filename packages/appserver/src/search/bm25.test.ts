/**
 * Unit tests for the sparse BM25 encoder (src/search/bm25.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  BM25_K1,
  tokenize,
  hashTerm,
  encodeSparse,
} from "./bm25.ts";

describe("tokenize", () => {
  test("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(tokenize("the quick brown fox")).toEqual(["the", "quick", "brown", "fox"]);
  });

  test("keeps non-ASCII letters (accents)", () => {
    expect(tokenize("café au lait")).toEqual(["café", "au", "lait"]);
  });

  test("yields nothing for punctuation/whitespace/empty", () => {
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("!!!")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("hashTerm", () => {
  test("is deterministic and uint32", () => {
    expect(hashTerm("fox")).toBe(hashTerm("fox"));
    expect(hashTerm("fox")).toBeGreaterThanOrEqual(0);
    expect(hashTerm("fox")).toBeLessThan(2 ** 32);
  });

  test("different terms usually differ", () => {
    const a = hashTerm("alpha");
    const b = hashTerm("beta");
    expect(a).not.toBe(b);
  });
});

describe("encodeSparse", () => {
  test("empty text yields empty vectors", () => {
    expect(encodeSparse("")).toEqual({ indices: [], values: [] });
  });

  test("indices are sorted ascending and aligned with values", () => {
    const { indices, values } = encodeSparse("the quick brown fox");
    expect(indices.length).toBe(4);
    expect(values.length).toBe(indices.length);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
    }
    expect(indices.every((ix) => ix >= 0 && ix < 2 ** 32)).toBe(true);
  });

  test("values are strictly positive and in (0, 1)", () => {
    const { values } = encodeSparse("the quick brown fox");
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("repeated terms weigh more than single occurrences", () => {
    const once = encodeSparse("the fox");
    const twice = encodeSparse("the the fox");
    const onceVal = once.values[once.indices.indexOf(hashTerm("the"))]!;
    const twiceVal = twice.values[twice.indices.indexOf(hashTerm("the"))]!;
    expect(twiceVal).toBeGreaterThan(onceVal);
    // BM25 tf saturation: tf/(tf+k1)
    expect(onceVal).toBeCloseTo(1 / (1 + BM25_K1), 6);
    expect(twiceVal).toBeCloseTo(2 / (2 + BM25_K1), 6);
  });

  test("is deterministic across calls", () => {
    const a = encodeSparse("the quick brown fox jumps");
    const b = encodeSparse("the quick brown fox jumps");
    expect(a).toEqual(b);
  });
});
