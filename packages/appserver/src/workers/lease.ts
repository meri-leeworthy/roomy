/**
 * Cross-replica ownership of the process-wide background loops.
 *
 * A lease is one row of the global `worker_leases` table: whoever last wrote
 * it and has not let `expires_at` pass holds it. Acquisition is a single
 * conditional upsert, so two replicas racing produce one winner without a
 * lock — the loser's `where` clause fails and it writes nothing. The current
 * holder always succeeds, which is what renews the claim.
 *
 * The lease lives in the global DB, the one file every replica opens, so a
 * loop can take it whichever pool (per-space or global) it otherwise runs on.
 *
 * A loop that holds a lease runs its body; one that does not defers, leaving
 * the work to the holder and picking it up if it ever becomes the holder
 * itself.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { openGlobalDb } from "../db/db.ts";
import { log } from "../log.ts";

/** This process's identity on a lease row, distinct per start. */
export const PROCESS_HOLDER = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;

/**
 * Try to take (or renew) the lease `name`. Returns true when `holder` holds
 * it afterwards.
 *
 * A failed write — including a DB error — reports "not held", so a replica
 * that cannot reach the global DB never acts as an owner.
 */
export async function acquireWorkerLease(
  name: string,
  holder: string,
  ttlMs: number,
  now = Date.now(),
): Promise<boolean> {
  const expiresAt = now + ttlMs;
  try {
    const result = await openGlobalDb().run(
      `insert into worker_leases (name, holder, expires_at, updated_at)
       values (?, ?, ?, ?)
       on conflict (name) do update set
         holder = excluded.holder,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       where worker_leases.holder = excluded.holder
          or worker_leases.expires_at <= ?`,
      name,
      holder,
      expiresAt,
      now,
      now,
    );
    return result.changes > 0;
  } catch (err) {
    log.error(
      `[lease] ${name} acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Give up the lease `name` if `holder` is the one holding it. Another
 * replica's claim is left alone, so a holder that lost the lease (expiry)
 * cannot delete the new holder's row.
 */
export async function releaseWorkerLease(
  name: string,
  holder: string,
): Promise<void> {
  try {
    await openGlobalDb().run(
      "delete from worker_leases where name = ? and holder = ?",
      name,
      holder,
    );
  } catch (err) {
    log.error(
      `[lease] ${name} release failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface WorkerLeaseOpts {
  /** The row this lease owns in `worker_leases`; one per loop. */
  name: string;
  /**
   * How long a claim stays valid without renewal. Also the upper bound on
   * how long a failed owner keeps the loop to itself.
   */
  ttlMs: number;
  /** Identity written on the row. Defaults to this process's. */
  holder?: string;
}

/**
 * A background loop's claim on a lease, renewed on a timer so a holder that
 * is busy or idle between cycles never loses it, and a holder that has died
 * is replaced within one TTL.
 */
export class WorkerLease {
  readonly name: string;
  readonly holder: string;
  readonly #ttlMs: number;
  readonly #renewMs: number;
  /** Clears the renewal timer, or undefined before {@link start}. */
  #stopRenewing: (() => void) | undefined;
  #held = false;

  constructor(opts: WorkerLeaseOpts) {
    this.name = opts.name;
    this.holder = opts.holder ?? PROCESS_HOLDER;
    this.#ttlMs = opts.ttlMs;
    // Three renewals per TTL: two may be missed before the claim lapses.
    this.#renewMs = Math.max(1000, Math.floor(opts.ttlMs / 3));
  }

  /** Whether this process holds the claim right now. */
  get held(): boolean {
    return this.#held;
  }

  /** Take the claim (if free) and keep renewing it until {@link stop}. */
  async start(): Promise<void> {
    this.#held = await acquireWorkerLease(this.name, this.holder, this.#ttlMs);
    if (this.#stopRenewing) return;
    const timer = setInterval(() => void this.#renew(), this.#renewMs);
    // Renewal is not a reason for the process to stay alive.
    timer.unref?.();
    this.#stopRenewing = () => clearInterval(timer);
  }

  /**
   * Stop renewing and give the claim up, so the next replica takes over on
   * its next renewal instead of waiting out the TTL.
   */
  async stop(): Promise<void> {
    this.#stopRenewing?.();
    this.#stopRenewing = undefined;
    if (!this.#held) return;
    this.#held = false;
    await releaseWorkerLease(this.name, this.holder);
  }

  /**
   * Run one unit of loop work, but only while this process holds the claim.
   * Returns null when it does not, so the caller can defer instead.
   */
  async runIfHeld<T>(body: () => Promise<T>): Promise<T | null> {
    if (!this.#held) return null;
    return await body();
  }

  async #renew(): Promise<void> {
    this.#held = await acquireWorkerLease(this.name, this.holder, this.#ttlMs);
  }
}
