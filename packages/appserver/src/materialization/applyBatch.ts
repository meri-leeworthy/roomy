/**
 * Apply a batch of decoded events to the per-space database.
 *
 * Events are processed in chunks, each chunk in a single `db.transaction()`
 * call. Per-event savepoints provide error isolation within each chunk.
 * This reduces ~115k transaction round-trips to ~230 (for 500-event chunks).
 *
 * Side-effects (activity_item, link detection) that need JS logic run
 * post-transaction since they're idempotent.
 *
 * Per-space split (Phase 3): `db` is the per-space DB — the source of truth
 * for space data. There is no monolithic DB. `globalDb` (optional) receives
 * the `joinedSpace`/`leftSpace` membership edges and the `entity_space`
 * entity→space index. The materialization cursor advances on the per-space
 * DB so each space DB is self-describing about its own re-materialisation
 * progress.
 */

import type { DbLike } from "../db/types.ts";
import type {
  DecodedStreamEvent,
  StreamDid,
  StreamIndex,
  Ulid,
} from "@roomy-space/sdk";

import { materialize } from "./materializer.ts";
import { applyBundle, savepointMutex } from "./applyBundle.ts";
import { isGlobalEdgeStatement } from "./statementRouting.ts";
import type { StatementBundleSuccess } from "./types.ts";
import {
  isDebugEnabled,
  recordMaterialization,
} from "../debug/eventStore.ts";
import {
  detectAndStoreLinks,
  detectAndStoreLinksFromUrls,
} from "../embed/enricher.ts";
import { openReadStateDb } from "../db/db.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { RICHTEXT_MIME, extractFacetUrls } from "@roomy-space/sdk";
import { decodeTime, ulid } from "ulidx";

import { log } from "../log.ts";
const MAX_TRACKED_FAILURES = 100;
const CHUNK_SIZE = 500;

export interface ApplyBatchOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
}

export interface MaterializationStats {
  applied: number;
  materializerErrors: number;
  applyErrors: number;
  failed: Array<{
    eventId: Ulid;
    type: string;
    reason: "materializer" | "apply";
    message: string;
  }>;
  detectedLinks: string[];
}

interface ChunkStep {
  type: "run" | "exec";
  sql: string;
  params?: unknown[];
  /** Derived-DB routing: "space" (default), "global", or "none" (no derived write). */
  derived: "space" | "global" | "none";
}

export async function applyBatch(
  db: DbLike,
  streamId: StreamDid,
  events: DecodedStreamEvent[],
  opts: ApplyBatchOpts,
  globalDb?: DbLike,
): Promise<MaterializationStats> {
  const stats: MaterializationStats = {
    applied: 0,
    materializerErrors: 0,
    applyErrors: 0,
    failed: [],
    detectedLinks: [],
  };

  if (events.length === 0) return stats;

  let latestIdx: StreamIndex = 0 as StreamIndex;
  for (const e of events) {
    if (e.idx > latestIdx) latestIdx = e.idx;
  }

  const total = events.length;
  const logInterval = Math.max(500, Math.round(total / 10));
  let nextLogAt = logInterval;

  // Process events in chunks, each chunk in one transaction
  for (let offset = 0; offset < events.length; offset += CHUNK_SIZE) {
    const chunk = events.slice(offset, offset + CHUNK_SIZE);
    const chunkSteps: ChunkStep[] = [];

    for (const e of chunk) {
      const bundle = materialize(e.event, { streamId, user: e.user }, e.idx);

      if (bundle.status === "error") {
        stats.materializerErrors++;
        recordFailure(stats, {
          eventId: bundle.eventId,
          type: e.event.$type,
          reason: "materializer",
          message: bundle.message,
        });
        if (isDebugEnabled()) {
          recordMaterialization({
            streamDid: streamId,
            idx: e.idx,
            eventType: e.event.$type,
            eventId: bundle.eventId,
            status: "materializer_error",
            errorMessage: bundle.message,
            bundle,
          });
        }
        continue;
      }

      // Per-event savepoint for error isolation within the chunk
      const savepoint = `evt_${e.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      chunkSteps.push({ type: "exec", sql: `savepoint ${savepoint}`, derived: "none" });
      for (const stmt of bundle.statements) {
        const params = stmt.params;
        chunkSteps.push({
          type: "run",
          sql: stmt.sql,
          params:
            params === undefined
              ? undefined
              : Array.isArray(params)
                ? (params as unknown[])
                : [params],
          derived: isGlobalEdgeStatement(stmt.sql) ? "global" : "space",
        });
        // Phase 3: maintain the global entity→space index. Every `insert
        // into entities` statement carries (id, stream_id) as its first two
        // params; record the mapping so `openSpaceDbForEntity` can resolve
        // which per-space DB a room/message id lives in. Skip entities with
        // an empty stream_id (e.g. link entities) — they are never resolved
        // via openSpaceDbForEntity.
        if (stmt.sql.trim().startsWith("insert into entities")) {
          const p = Array.isArray(params) ? params : [params];
          const id = p[0];
          const sid = p[1];
          if (typeof id === "string" && typeof sid === "string" && sid !== "") {
            chunkSteps.push({
              type: "run",
              sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
              params: [id, sid],
              derived: "global",
            });
          }
        }
      }

      // sort_idx: inline the UPDATE (no SELECT needed)
      if (e.event.$type === "space.roomy.message.createMessage.v0") {
        const event = e.event as Record<string, unknown>;
        const overrideExt =
          (event.extensions as Record<string, unknown> | undefined)?.["space.roomy.extension.timestampOverride.v0"] as
            | { timestamp?: string }
            | undefined;
        const timestamp = overrideExt
          ? Number(overrideExt.timestamp)
          : decodeTime(e.event.id);
        const sortIdx = ulid(timestamp) as Ulid;
        chunkSteps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [sortIdx, e.event.id],
          derived: "space",
        });
      }

      // forwardMessages sort_idx copy
      if (
        e.event.$type === "space.roomy.message.forwardMessages.v0" &&
        "messageIds" in e.event &&
        Array.isArray((e.event as Record<string, unknown>).messageIds)
      ) {
        const messageIds = (e.event as Record<string, unknown>).messageIds as string[];
        const originalId = messageIds[0];
        if (originalId) {
          chunkSteps.push({
            type: "run",
            sql: "update entities set sort_idx = (select sort_idx from entities where id = ?) where id = ? and sort_idx is null",
            params: [originalId, e.event.id],
            derived: "space",
          });
        }
      }

      chunkSteps.push({ type: "exec", sql: `release ${savepoint}`, derived: "none" });

      stats.applied++;

      if (isDebugEnabled()) {
        recordMaterialization({
          streamDid: streamId,
          idx: e.idx,
          eventType: e.event.$type,
          eventId: e.event.id,
          status: "applied",
          bundle,
        });
      }

      const done = stats.applied + stats.materializerErrors + stats.applyErrors;
      if (done >= nextLogAt && done < total) {
        nextLogAt = done + logInterval;
        const pct = Math.round((done / total) * 100);
        log.info("materialize", `${streamId}: ${done}/${total} events (${pct}%) — ${stats.applied} applied, ${stats.materializerErrors} materializer errors, ${stats.applyErrors} apply errors`);
      }
    }

    // Compute the max idx for this chunk — used to advance the cursor after
    // the chunk is processed (whether it succeeded or failed).
    let chunkMaxIdx: StreamIndex = 0 as StreamIndex;
    for (const e of chunk) {
      if (e.idx > chunkMaxIdx) chunkMaxIdx = e.idx;
    }

    // Run this chunk's event SQL individually, with per-event savepoints
    // providing error isolation. Each event's SAVEPOINT/RELEASE pair wraps
    // its statements; if one event fails, only that event's changes are
    // rolled back. The cursor is advanced separately below so it also
    // advances past chunks with apply errors, preventing infinite retry
    // loops on every boot.
    //
    // The savepoint-managed section is serialized on the process-wide
    // `savepointMutex` shared with `applyBundle`: both manage
    // SAVEPOINT/RELEASE via individual async db.exec calls, and concurrent
    // sections interleave and destroy each other's savepoints. This is the
    // race between boot-time re-materialization (backfill) and live
    // `sendEvents` on the same space — the replay is fire-and-forget and
    // does not share the StreamManager's per-stream serialization queue.
    await savepointMutex.run(async () => {
      if (chunkSteps.length > 0) {
        for (let i = 0; i < chunkSteps.length; i++) {
          const step = chunkSteps[i]!;
          if (step.type === "exec" && step.sql.startsWith("savepoint evt_")) {
            // Collect all steps for this event (savepoint → statements → release)
            const eventSteps: ChunkStep[] = [];
            for (let j = i; j < chunkSteps.length; j++) {
              const s = chunkSteps[j]!;
              eventSteps.push(s);
              if (s.type === "exec" && s.sql.startsWith("release evt_")) {
                i = j;
                break;
              }
            }
            // ── Per-space DB (source of truth) ──────────────────────────
            // Run the space statements first; the savepoint commits on
            // release. A failure here rolls back the event on the space DB.
            let spaceFailed = false;
            try {
              for (const s of eventSteps) {
                if (s.type === "run") {
                  if (s.derived === "space") {
                    await db.run(s.sql, ...(s.params ?? []));
                  }
                } else if (s.sql.startsWith("release evt_")) {
                  continue;
                } else {
                  await db.exec(s.sql);
                }
              }
              await db.exec(`release ${savepointName(eventSteps[0]!)}`);
            } catch (err) {
              spaceFailed = true;
              const name = savepointName(eventSteps[0]!);
              try {
                await db.exec(`rollback to ${name}`);
                await db.exec(`release ${name}`);
              } catch {
                // Best-effort cleanup
              }
              const message = err instanceof Error ? err.message : String(err);
              stats.applyErrors++;
              stats.applied--;
              recordFailure(stats, {
                eventId: "" as unknown as Ulid,
                type: "unknown",
                reason: "apply",
                message,
              });
            }
            if (spaceFailed) continue;

            // ── Global DB ──────────────────────────────────────────────
            // Membership edges + entity_space index. A failure here never
            // rolls back the per-space DB — the event stays applied there
            // and the global DB is repaired by re-materialisation.
            if (globalDb) {
              const globalSteps = eventSteps.filter(
                (s) => s.derived === "global",
              );
              if (globalSteps.length > 0) {
                try {
                  await globalDb.exec(`savepoint ${savepointName(eventSteps[0]!)}`);
                  for (const s of globalSteps) {
                    if (s.type === "run") {
                      await globalDb.run(s.sql, ...(s.params ?? []));
                    } else {
                      await globalDb.exec(s.sql);
                    }
                  }
                  await globalDb.exec(`release ${savepointName(eventSteps[0]!)}`);
                } catch (globalErr) {
                  const name = savepointName(eventSteps[0]!);
                  try {
                    await globalDb.exec(`rollback to ${name}`);
                    await globalDb.exec(`release ${name}`);
                  } catch {
                    /* best-effort */
                  }
                  const message =
                    globalErr instanceof Error ? globalErr.message : String(globalErr);
                  stats.applyErrors++;
                  recordFailure(stats, {
                    eventId: "" as unknown as Ulid,
                    type: "global-db",
                    reason: "apply",
                    message: `[globalDb] ${message}`,
                  });
                  console.error(
                    `[materialize] globalDb write failed for ${streamId} (per-space intact): ${message}`,
                  );
                }
              }
            }
          }
        }
      }
    });

    // Advance the materialization cursor for this chunk. This is a SEPARATE
    // transaction from the chunk's event SQL, so it advances even when the
    // chunk had apply errors. Without this, streams with 100% apply errors
    // would never advance the cursor and would be fully replayed on every
    // boot — an infinite retry loop. The materializer output is idempotent
    // (upserts), so if a crash happens between the chunk commit and this
    // cursor update, the chunk is replayed on restart but produces the same
    // result — harmless.
    await db.run(
      `insert into materialization_cursor (stream_id, materialized_to)
       values (?, ?)
       on conflict (stream_id) do update set materialized_to = excluded.materialized_to
       where materialization_cursor.materialized_to < excluded.materialized_to`,
      streamId,
      chunkMaxIdx,
    );

    // Post-transaction side-effects for this chunk: activity_item upsert and
    // link detection. These need JS logic so they can't be inlined as SQL
    // steps. Running them per-chunk keeps them interleaved with progress
    // logging rather than causing a long freeze after the last progress line.
    await applyChunkSideEffects(db, chunk, streamId, opts.isBackfill, stats.detectedLinks, globalDb);
  }

  // Advance the legacy comp_space.backfilled_to cursor. The authoritative
  // materialization_cursor is now advanced per-chunk (above), so it already
  // reflects progress. This legacy cursor is kept for backwards compatibility
  // and only exists for streams that have a comp_space row.
  await db.transaction([
    {
      type: "run",
      sql: `update comp_space
           set backfilled_to = ?,
               updated_at = (unixepoch() * 1000)
           where entity = ?
             and (backfilled_to is null or backfilled_to < ?)`,
      params: [latestIdx, streamId, latestIdx],
    },
  ]);

  return stats;
}

function savepointName(step: ChunkStep): string {
  return step.sql.startsWith("savepoint ")
    ? step.sql.slice("savepoint ".length)
    : `evt_${step.sql.length}`;
}

/**
 * Post-transaction side-effects for a chunk: activity_item upsert and link
 * detection. These need JS logic (JSON array manipulation, URL extraction)
 * so they can't be inlined as SQL steps. Running them per-chunk keeps them
 * interleaved with progress logging rather than causing a long freeze after
 * the last progress line.
 */
async function applyChunkSideEffects(
  db: DbLike,
  chunk: DecodedStreamEvent[],
  streamId: StreamDid,
  isBackfill: boolean,
  detectedLinks: string[],
  globalDb?: DbLike,
): Promise<void> {
  for (const e of chunk) {
    if (e.event.$type === "space.roomy.message.createMessage.v0" && (e.event as Record<string, unknown>).room) {
      const bundle: StatementBundleSuccess = {
        status: "success",
        event: e.event,
        eventIdx: e.idx,
        user: e.user,
        statements: [],
        dependsOn: [],
      };
      await applyBundle(db, bundle, { isBackfill, streamId }, globalDb, openReadStateDb());

      const body = (e.event as Record<string, unknown>).body as
        | { mimeType?: string; data?: { buf: Uint8Array } }
        | undefined;
      if (body?.data?.buf) {
        const mime = body.mimeType ?? "text/markdown";
        const buf = Buffer.from(body.data.buf);
        let detected: string[];
        if (mime === RICHTEXT_MIME) {
          // New format: URLs come from `#link` facet URIs, not regex scanning.
          const blocks = decodeRichTextBody(mime, buf);
          detected = await detectAndStoreLinksFromUrls(
            db,
            e.event.id,
            blocks ? extractFacetUrls(blocks) : [],
          );
        } else {
          // Legacy text/markdown bodies keep the regex extraction path.
          const content = decodeContent(mime, buf);
          detected = await detectAndStoreLinks(db, e.event.id, content);
        }
        if (detected.length > 0) detectedLinks.push(...detected);
        if (globalDb && detected.length > 0) {
          // Record the link entities in the global entity→space index so
          // they resolve to this space (they carry an empty stream_id in
          // the per-space DB).
          for (const url of detected) {
            await globalDb.run(
              `insert or ignore into entity_space (entity_id, space_did) values (?, ?)`,
              [url, streamId],
            );
          }
          // Dual-write the global pending-links index so the centralized
          // embed sweeper can find this work without iterating every
          // per-space DB. `insert or ignore` keeps the row idempotent across
          // re-materialisation.
          for (const url of detected) {
            await globalDb.run(
              `insert or ignore into pending_links (space_did, message_id, url, created_at)
               values (?, ?, ?, ?)`,
              [streamId, e.event.id, url, Date.now()],
            );
          }
        }
      }
    }
  }
}

function recordFailure(
  stats: MaterializationStats,
  failure: MaterializationStats["failed"][number],
): void {
  if (stats.failed.length < MAX_TRACKED_FAILURES) {
    stats.failed.push(failure);
  }
}
