/**
 * Boot readiness — what `/health` reports while the process is still catching
 * its materialised views up from the event log.
 *
 * The process binds its port and serves XRPC before the boot sweep has walked
 * the per-space DBs, so a request that arrives in that window is answered by a
 * pool that is mid-sweep: the sweep's reads and the request's reads contend for
 * the same workers and the same disk. Reporting `ready` from the moment the
 * socket accepts is what routes that traffic in, so readiness is a separate
 * fact from listening: it turns true when the sweep's first pass completes.
 *
 * `/health` answers 503 with `status: "starting"` until then, which is the
 * signal a platform health check reads before it starts routing (and which a
 * rolling deploy holds the previous instance behind).
 */

import type { ReMaterializeProgress } from "./streams/reMaterialize.ts";

export type BootPhase =
  | "starting"
  | "sweeping"
  | "replaying"
  | "finishing"
  | "ready"
  | "failed";

/** The body `/health`'s `boot` field carries. */
export interface BootReadiness {
  /** True once the boot sweep's first pass has completed. */
  ready: boolean;
  phase: BootPhase;
  /** Milliseconds since the process installed its boot record. */
  elapsed_ms: number;
  /** Streams the sweep found in the event log this boot. */
  streams_total: number;
  /** Streams whose per-space state it has read. */
  streams_scanned: number;
  /** Streams found needing replay, and how far that replay has got. */
  replay_total: number;
  replay_done: number;
  replay_failed: number;
}

/** The snapshot a server that is not booting reports: always ready. */
export const READY: BootReadiness = {
  ready: true,
  phase: "ready",
  elapsed_ms: 0,
  streams_total: 0,
  streams_scanned: 0,
  replay_total: 0,
  replay_done: 0,
  replay_failed: 0,
};

/** A provider for `AppserverOptions.readiness`; the default is `READY`. */
export type ReadinessProvider = () => BootReadiness;

/** Mutable boot state, driven by the process entry point as the sweep runs. */
export class BootReadinessTracker {
  readonly #startedAt = Date.now();
  #phase: BootPhase = "starting";
  #streamsTotal = 0;
  #streamsScanned = 0;
  #replayTotal = 0;
  #replayDone = 0;
  #replayFailed = 0;

  /** Move the phase without touching the counts. */
  setPhase(phase: BootPhase): void {
    this.#phase = phase;
  }

  /** Fold in a sweep progress report. */
  update(progress: ReMaterializeProgress): void {
    // "done" ends the pass; it does not make the process ready. The caller
    // that owns the boot sequence calls `markReady` once the pass has returned,
    // so a throw after the final report can still leave it not-ready.
    if (progress.phase !== "done") this.#phase = progress.phase;
    if (progress.streamsTotal !== undefined) this.#streamsTotal = progress.streamsTotal;
    if (progress.streamsScanned !== undefined) this.#streamsScanned = progress.streamsScanned;
    if (progress.replayTotal !== undefined) this.#replayTotal = progress.replayTotal;
    if (progress.replayDone !== undefined) this.#replayDone = progress.replayDone;
    if (progress.replayFailed !== undefined) this.#replayFailed = progress.replayFailed;
  }

  /** The sweep's first pass completed: the process is serving current data. */
  markReady(): void {
    this.#phase = "ready";
    this.#streamsScanned = this.#streamsTotal;
  }

  /**
   * The sweep threw. Reads are served from whatever is materialised, which is
   * not the state this boot promises, so the process stays not-ready and the
   * orchestrator keeps the previous instance serving.
   */
  markFailed(): void {
    this.#phase = "failed";
  }

  snapshot(): BootReadiness {
    return {
      ready: this.#phase === "ready",
      phase: this.#phase,
      elapsed_ms: Date.now() - this.#startedAt,
      streams_total: this.#streamsTotal,
      streams_scanned: this.#streamsScanned,
      replay_total: this.#replayTotal,
      replay_done: this.#replayDone,
      replay_failed: this.#replayFailed,
    };
  }
}
