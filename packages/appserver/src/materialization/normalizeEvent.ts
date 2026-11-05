/**
 * Bring a log entry's decoded payload up to the current event envelope.
 *
 * The log is append-only and the cursor advances past whatever it reads, so a
 * reader that recognises only the current shape loses the entries that were
 * written under an earlier one. The historical shape it has to recognise is the
 * nested envelope:
 *
 *     { id, room?, variant: { $type, ...body } }
 *
 * The Leaf-era client wrote exactly that (`sendEvent(streamId, encode(event))`
 * in the deleted `packages/app`, with `Event = { id, variant }`), and the rows
 * were copied byte-for-byte into `stream_events` by the Leaf migration. The
 * kind and body sit one level down on `variant`; `id` is on the outer object
 * and, in the older of the two variants, so is `room`.
 *
 * Flattening it restores the shape every consumer downstream expects (`$type`,
 * `id`, body fields at the top level), so routing, the materialiser and the
 * post-apply side effects all read one shape.
 *
 * A payload that matches neither shape is returned unchanged: an unrecognised
 * entry must reach the materialiser so it is counted and named as a skip,
 * never silently rewritten into something it is not.
 */
import type { Event } from "@roomy-space/sdk";

export function normalizeStoredEvent(decoded: unknown): Event {
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    return decoded as Event;
  }

  const envelope = decoded as {
    $type?: unknown;
    id?: unknown;
    room?: unknown;
    variant?: unknown;
  };
  if (typeof envelope.$type === "string") return decoded as Event;

  const variant = envelope.variant;
  if (
    variant === null ||
    typeof variant !== "object" ||
    Array.isArray(variant)
  ) {
    return decoded as Event;
  }

  const body = variant as Record<string, unknown> & { $type?: unknown };
  // Every envelope carries the event's ULID on the outer object. A payload
  // without one is not this shape and must not be passed on as if it were:
  // materialisation keys its per-event work by that id.
  if (typeof body.$type !== "string" || typeof envelope.id !== "string") {
    return decoded as Event;
  }

  const event: Record<string, unknown> = { ...body, id: envelope.id };
  // `room` lived on the envelope before it moved into the variant, then into
  // the event itself; carry the envelope's copy only when the variant has none.
  if (event.room === undefined && envelope.room !== undefined) {
    event.room = envelope.room;
  }
  return event as unknown as Event;
}
