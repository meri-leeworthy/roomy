/**
 * Tests for the event-loop lag instrument.
 *
 * The defect it exists for is a host stall: the process kept serving, the
 * workers reported 30-plus seconds inside SQLite, and nothing in-process said
 * that this thread had also been late. Two things are asserted, and both have
 * to be real rather than simulated:
 *
 *   1. A synchronous block of this thread shows up as exactly ONE observation
 *      above the spike bound, and is not counted twice. One, not a burst: a
 *      35 s stall has to read as a single event.
 *   2. Starting the sampler does not keep a process alive. It runs an interval
 *      inside the server, so the only honest check is a child process allowed
 *      to exit on its own (`eventLoopLag.fixture.ts`).
 *
 * Windows are closed by hand here (the interval is set far out of reach): the
 * monitor measures the platform clock, so what the test drives is the block,
 * not a duration.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { metrics } from "../metrics.ts";
import { EventLoopLagSampler } from "./eventLoopLag.ts";

const FIXTURE = fileURLToPath(new URL("./eventLoopLag.fixture.ts", import.meta.url));

/** A loop delay past this is a stall, not jitter. Matches the 0.25 s bucket. */
const SPIKE_BOUND = 0.25;

interface LagExposition {
  /** Observations recorded so far, i.e. sampling windows closed. */
  count: number;
  /** Observations strictly above {@link SPIKE_BOUND}. */
  aboveBound: number;
}

/** Read the process-wide lag histogram out of the scrape body. */
function readLag(): LagExposition {
  const buckets: Array<{ le: number; value: number }> = [];
  let count = 0;
  for (const line of metrics.render().split("\n")) {
    const bucket = /^roomy_event_loop_delay_seconds_bucket\{le="([^"]+)"\} (\d+)$/.exec(line);
    if (bucket) {
      buckets.push({ le: bucket[1] === "+Inf" ? Infinity : Number(bucket[1]), value: Number(bucket[2]) });
      continue;
    }
    const total = /^roomy_event_loop_delay_seconds_count (\d+)$/.exec(line);
    if (total) count = Number(total[1]);
  }
  // Bucket counts are cumulative, so everything above the bound is the total
  // minus the count that ended at or below it.
  const atOrBelow = Math.max(
    0,
    ...buckets.filter((b) => b.le <= SPIKE_BOUND).map((b) => b.value),
  );
  return { count, aboveBound: Math.max(0, count - atOrBelow) };
}

/** Block this thread: no monitor tick, timer or I/O callback can run. */
function blockFor(ms: number): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    // Synchronous work by construction.
  }
}

/**
 * Let an overdue monitor tick land. Its timer was scheduled before this one and
 * is already due, so it runs first — no "long enough" delay is involved.
 */
function afterLoopTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

/**
 * Close windows until one carries a tick. Bun's monitor starts measuring only
 * after its first tick, so a window opened at start() has nothing to report.
 * Bounded, so a monitor that never ticks fails the test instead of hanging it.
 */
async function warmUp(sampler: EventLoopLagSampler): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await afterLoopTick();
    if (sampler.sample() > 0) return;
  }
  throw new Error("the event-loop monitor never recorded a tick");
}

describe("EventLoopLagSampler", () => {
  test("a synchronous block is one observation above the spike bound", async () => {
    const sampler = new EventLoopLagSampler(60_000);
    sampler.start();
    try {
      await warmUp(sampler);
      const before = readLag();

      blockFor(300);
      let blockedWindow = 0;
      for (let attempt = 0; attempt < 100 && blockedWindow === 0; attempt++) {
        await afterLoopTick();
        blockedWindow = sampler.sample();
      }
      // The same window closed again: nothing has ticked since the reset, so
      // the block cannot be observed a second time.
      const closedAgain = sampler.sample();

      const after = readLag();
      expect(blockedWindow).toBeGreaterThan(SPIKE_BOUND);
      expect(closedAgain).toBe(0);
      expect(after.count - before.count).toBe(1);
      expect(after.aboveBound - before.aboveBound).toBe(1);
    } finally {
      sampler.stop();
    }
  });

  test("a stopped sampler records nothing", async () => {
    const sampler = new EventLoopLagSampler(60_000);
    sampler.start();
    sampler.stop();
    expect(sampler.running).toBe(false);

    const before = readLag();
    blockFor(100);
    await afterLoopTick();
    expect(sampler.sample()).toBe(0);
    expect(readLag().count).toBe(before.count);
  });

  test("the sampling interval does not keep a process alive", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", FIXTURE],
      stdout: "ignore",
      stderr: "pipe",
    });
    // Watchdog, not a wait: the fixture must exit on its own, and one that
    // never does is killed so this test fails with its stderr instead of
    // hanging the run.
    let hung = false;
    const watchdog = setTimeout(() => {
      hung = true;
      proc.kill();
    }, 5000);
    const exitCode = await proc.exited;
    clearTimeout(watchdog);
    const stderr = await new Response(proc.stderr).text();
    if (hung) {
      throw new Error(`sampler held the process open: ${stderr}`);
    }
    expect(exitCode).toBe(0);
  });
});
