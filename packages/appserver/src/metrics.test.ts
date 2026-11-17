import { describe, expect, test } from "bun:test";
import { Metrics } from "./metrics.ts";

describe("metrics registry", () => {
  test("counter increments and renders", () => {
    const m = new Metrics();
    const c = m.counter("roomy_test_total", "test counter", ["endpoint"]);
    c.inc({ endpoint: "/a" });
    c.inc({ endpoint: "/a" });
    c.inc({ endpoint: "/b" });
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_total counter");
    expect(out).toContain('roomy_test_total{endpoint="/a"} 2');
    expect(out).toContain('roomy_test_total{endpoint="/b"} 1');
  });

  test("gauge set and inc", () => {
    const m = new Metrics();
    const g = m.gauge("roomy_test_gauge", "test gauge", ["worker"]);
    g.set({ worker: "system" }, 8);
    g.inc({ worker: "system" }, 1);
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_gauge gauge");
    expect(out).toContain('roomy_test_gauge{worker="system"} 9');
  });

  test("histogram buckets, sum, count", () => {
    const m = new Metrics();
    const h = m.histogram("roomy_test_seconds", "test hist", ["endpoint"], [0.1, 0.5, 1]);
    h.observe({ endpoint: "/a" }, 0.05);
    h.observe({ endpoint: "/a" }, 0.2);
    h.observe({ endpoint: "/a" }, 2);
    const out = m.render();
    expect(out).toContain("# TYPE roomy_test_seconds histogram");
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="0.1"} 1');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="0.5"} 2');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="1"} 2');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",le="+Inf"} 3');
    expect(out).toContain('roomy_test_seconds_sum{endpoint="/a"} 2.25');
    expect(out).toContain('roomy_test_seconds_count{endpoint="/a"} 3');
  });

  test("empty registry renders empty string", () => {
    const m = new Metrics();
    expect(m.render()).toBe("");
  });

  test("histogramSeries interpolates p50 and p90 within their buckets", () => {
    const m = new Metrics();
    const h = m.histogram("roomy_test_seconds", "test hist", ["db"], [0.1, 0.5, 1]);
    // Two observations in the 0.5 bucket and two in the 1s bucket, so both
    // quantiles fall inside a bucket whose neighbours are non-empty.
    for (const v of [0.2, 0.2, 0.6, 0.6]) h.observe({ db: "global" }, v);

    const [series] = m.histogramSeries("roomy_test_seconds");
    expect(series?.labels).toEqual({ db: "global" });
    expect(series?.count).toBe(4);
    // p50 = rank 2, at the top of the 0.1–0.5 bucket; p90 = rank 3.6, 80% of
    // the way through the 0.5–1 bucket.
    expect(series?.p50).toBe(0.5);
    expect(series?.p90).toBe(0.9);
  });

  test("histogramSeries reports null above the top finite bucket", () => {
    const m = new Metrics();
    const h = m.histogram("roomy_test_seconds", "test hist", ["db"], [0.1, 0.5, 1]);
    h.observe({ db: "global" }, 0.05);
    h.observe({ db: "global" }, 0.2);
    h.observe({ db: "global" }, 2);

    const [series] = m.histogramSeries("roomy_test_seconds");
    expect(series?.count).toBe(3);
    expect(series?.p50).toBe(0.3);
    // Rank 2.7 is past every finite bucket: unreportable, not "1 second".
    expect(series?.p90).toBeNull();
  });

  test("histogramSeries yields nothing for an unknown or non-histogram family", () => {
    const m = new Metrics();
    m.counter("roomy_test_total", "test counter");
    expect(m.histogramSeries("roomy_test_total")).toEqual([]);
    expect(m.histogramSeries("roomy_absent_seconds")).toEqual([]);
  });
});

describe("constant labels", () => {
  test("every counter and gauge sample carries the constant label", () => {
    const m = new Metrics({ replica: "replica-a" });
    m.counter("roomy_test_total", "test counter", ["endpoint"]).inc({ endpoint: "/a" });
    m.gauge("roomy_test_gauge", "test gauge").set({}, 3);
    const out = m.render();
    expect(out).toContain('roomy_test_total{endpoint="/a",replica="replica-a"} 1');
    // A family with no declared labels renders the constant one alone.
    expect(out).toContain('roomy_test_gauge{replica="replica-a"} 3');
  });

  test("every histogram line carries the constant label, the bucket before le", () => {
    const m = new Metrics({ replica: "replica-a" });
    const h = m.histogram("roomy_test_seconds", "test hist", ["endpoint"], [0.1, 1]);
    h.observe({ endpoint: "/a" }, 0.05);
    h.observe({ endpoint: "/a" }, 2);
    const out = m.render();
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",replica="replica-a",le="0.1"} 1');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",replica="replica-a",le="1"} 1');
    expect(out).toContain('roomy_test_seconds_bucket{endpoint="/a",replica="replica-a",le="+Inf"} 2');
    expect(out).toContain('roomy_test_seconds_sum{endpoint="/a",replica="replica-a"} 2.05');
    expect(out).toContain('roomy_test_seconds_count{endpoint="/a",replica="replica-a"} 2');

    const bare = new Metrics({ replica: "replica-a" });
    bare.histogram("roomy_test_bare_seconds", "test hist", [], [0.1]).observe({}, 0.05);
    expect(bare.render()).toContain('roomy_test_bare_seconds_bucket{replica="replica-a",le="0.1"} 1');
    expect(bare.render()).toContain('roomy_test_bare_seconds_sum{replica="replica-a"} 0.05');
  });

  test("no constant label when the set is empty", () => {
    const m = new Metrics();
    m.counter("roomy_test_total", "test counter", ["endpoint"]).inc({ endpoint: "/a" });
    m.gauge("roomy_test_gauge", "test gauge").set({}, 1);
    const out = m.render();
    expect(out).toContain('roomy_test_total{endpoint="/a"} 1');
    expect(out).toContain("roomy_test_gauge 1");
    expect(out).not.toContain("replica=");
  });

  test("a family that already declares replica is not double-labelled", () => {
    const m = new Metrics({ replica: "replica-a" });
    m.counter("roomy_test_total", "test counter", ["replica"]).inc({ replica: "declared" });
    const out = m.render();
    expect(out).toContain('roomy_test_total{replica="declared"} 1');
    expect(out).not.toContain('replica="replica-a"');
  });

  test("the constant label does not participate in the sample key", () => {
    const m = new Metrics({ replica: "replica-a" });
    const c = m.counter("roomy_test_total", "test counter", ["endpoint"]);
    c.inc({ endpoint: "/a" });
    c.inc({ endpoint: "/b" });
    const out = m.render();
    expect(out).toContain('roomy_test_total{endpoint="/a",replica="replica-a"} 1');
    expect(out).toContain('roomy_test_total{endpoint="/b",replica="replica-a"} 1');
  });
});
