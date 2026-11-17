/**
 * Event-loop lag instrument.
 *
 * `monitorEventLoopDelay` reports how late the loop's own tick ran, so a
 * window in which this thread was blocked inside synchronous work shows up as
 * a large `max`. It is the one observation that separates a host stall from a
 * slow query: database work runs on worker threads and cannot hold this loop,
 * so a late loop alongside slow statements on several workers says the
 * blocking was outside both.
 *
 * Each sample publishes the LONGEST delay seen since the previous sample as a
 * single histogram observation. A 35 s block is therefore one bucket sample
 * rather than a burst of identical ones, and a scrape can tell which window
 * carried it from the observation count alone.
 *
 * Off by default in the sense that the family is registered on first start: a
 * process that never enables the sampler publishes no such series at all, so
 * its absence reads as "instrument off" rather than "zero lag".
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { metrics, type HistogramHandle } from "../metrics.ts";

/** Buckets in seconds. */
export const EVENT_LOOP_DELAY_BUCKETS = [
  // Healthy loop lag sits in the low milliseconds and the top of the range
  // covers the multi-tens-of-seconds block this instrument exists to catch.
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/** Monitor resolution: fine enough to see a sub-100 ms block, coarse enough
 *  that its own tick is not a meaningful share of what it measures. */
const RESOLUTION_MS = 10;

/** How often a window is closed. One observation per window. */
const SAMPLE_INTERVAL_MS = 1000;

/**
 * Registered on first start and reused afterwards: a second sampler in the
 * same process must add to the existing family rather than replace it
 * (`Metrics.histogram` overwrites a same-named family), which would silently
 * drop every sample taken before it.
 */
let delay: HistogramHandle | null = null;

function delayHistogram(): HistogramHandle {
  delay ??= metrics.histogram(
    "roomy_event_loop_delay_seconds",
    "Longest event-loop delay observed in each sampling window (seconds). A window containing a block carries one observation, in the bucket that block reaches.",
    [],
    EVENT_LOOP_DELAY_BUCKETS,
  );
  return delay;
}

export class EventLoopLagSampler {
  #monitor: IntervalHistogram;
  #intervalMs: number;
  #stopInterval: (() => void) | undefined;
  #histogram: HistogramHandle | undefined;

  constructor(intervalMs: number = SAMPLE_INTERVAL_MS) {
    this.#monitor = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.#intervalMs = intervalMs;
  }

  get running(): boolean {
    return this.#stopInterval !== undefined;
  }

  /**
   * Start sampling. Idempotent. The interval is unref'd so a process with
   * nothing else to do — a test, a one-shot script — can still exit.
   */
  start(): void {
    if (this.#stopInterval !== undefined) return;
    this.#histogram = delayHistogram();
    this.#monitor.enable();
    const timer = setInterval(() => this.sample(), this.#intervalMs);
    timer.unref?.();
    this.#stopInterval = () => clearInterval(timer);
  }

  /**
   * Close the current window: record its longest delay as one observation and
   * reset the monitor for the next one. Returns the delay in seconds, or 0
   * when the window recorded no tick at all. A no-op while stopped, so a late
   * caller cannot publish into a stopped instrument.
   */
  sample(): number {
    if (this.#histogram === undefined) return 0;
    if (this.#monitor.count === 0) {
      // No tick was serviced in this window, so there is no delay to report.
      // Recording 0 would claim a healthy loop with nothing measured.
      return 0;
    }
    const seconds = this.#monitor.max / 1e9;
    this.#monitor.reset();
    this.#histogram.observe({}, seconds);
    return seconds;
  }

  /** Stop sampling and release the monitor's timer. Idempotent. */
  stop(): void {
    this.#stopInterval?.();
    this.#stopInterval = undefined;
    this.#monitor.disable();
    this.#histogram = undefined;
  }
}
