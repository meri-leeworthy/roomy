/**
 * Per-event materialiser: turns one decoded Event into a bundle of SQL
 * statements via the SDK's pure `getMaterializer` registry.
 *
 * Synchronous (no async channel pipeline), and it does not re-declare
 * EdgeLabel/EdgesMap — those types live in the SDK and are imported where
 * needed.
 */

import {
  type Event,
  type StreamIndex,
  getDependsOn,
  getMaterializer,
} from "@roomy-space/sdk";

import type {
  MaterializeOpts,
  StatementBundle,
  StatementBundleSuccess,
} from "./types.ts";
import { log } from "../log.ts";

/** Run the SDK materialiser for a single event and wrap the result. */
export function materialize(
  event: Event,
  opts: MaterializeOpts,
  idx: StreamIndex,
): StatementBundle {
  const kind = event.$type;

  // Check if we have a materializer for this event type before attempting
  const handler = getMaterializer(kind);
  if (!handler) {
    // The stream is on the line because this is the only per-event record of a
    // skip, and a boot's worth of them arrives in one second: without it a skip
    // cannot be attributed. `payloadKeys` names the shape the stored entry does
    // have when it carries no kind at all, which is how an entry written under
    // a shape this build does not know stays diagnosable.
    const payloadKeys =
      kind === undefined && event !== null && typeof event === "object"
        ? Object.keys(event).join(",")
        : undefined;
    log.warn(
      `[materialize] no materializer for event ${event.id} in ${opts.streamId} (kind: ${kind}) — skipping` +
        (payloadKeys === undefined ? "" : ` [payload keys: ${payloadKeys}]`),
    );
    return {
      status: "error",
      eventId: event.id,
      message: `No materializer found for event kind: ${kind}`,
    };
  }

  try {
    const statements = handler({
      // A caller with no log behind it (a test, a direct SDK use) gets
      // wall-clock time; every appserver path supplies the entry's instant.
      decidedAt: Date.now(),
      ...opts,
      event,
    } as Parameters<typeof handler>[0]);

    const dependsOn = getDependsOn(event);

    return {
      status: "success",
      event,
      eventIdx: idx,
      user: opts.user,
      statements: Array.isArray(statements) ? statements : [statements],
      dependsOn,
    } satisfies StatementBundleSuccess;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[materialize] failed for event ${event.id} (${kind}): ${message}`);
    return {
      status: "error",
      eventId: event.id,
      message,
    };
  }
}
