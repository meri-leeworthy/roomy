/**
 * Where a push notification points, read from the payload a push carried.
 *
 * The appserver builds one payload shape for every transport
 * (`packages/appserver/src/push/types.ts`): `{ type, spaceId, roomId,
 * messageId?, … }`. What differs is how it arrives:
 *
 * - The service worker reads it from `event.notification.data` (see
 *   `src/service-worker.ts`).
 * - The native plugin emits `{ title?, body?, data }`, where `data` is the
 *   APNs payload's non-`aps` keys on iOS and the FCM data map on Android. Both
 *   transports put the appserver's payload as a JSON *string* under `roomy`
 *   (see `packages/appserver/src/push/transports/{apn,fcm}.ts`), so the route
 *   is inside that string.
 *
 * This module is the native reader: `routeFromEvent` answers "where does this
 * event point?", and `routeHref` renders the SvelteKit path for it. It is
 * deliberately free of plugin and framework imports — the native push module
 * owns the plugin wiring, this owns the payload contract, so the contract is
 * testable without a shell or a router.
 */

/** Where a notification should take the user. */
export interface NativePushRoute {
  spaceId: string;
  roomId: string;
  messageId?: string;
}

/**
 * The `spaceId`/`roomId`/`messageId` an event carries, read defensively.
 *
 * Every candidate that might carry the route is collected first — the event
 * value itself, its `data`, and the parsed `roomy` JSON string from either of
 * those — then the first one holding a usable `spaceId`/`roomId` pair wins.
 * Every read is guarded, so a payload of an unexpected shape yields "no route"
 * rather than a throw: this runs inside the plugin's event loop, where a
 * rejected payload must not take down the callback that delivered it.
 *
 * An empty id is not an id. The appserver resolves `spaceId`/`roomId` from
 * materialised rows, so `""` means that lookup missed; rendering it would
 * navigate to `//<roomId>`, which a router reads as a protocol-relative URL on
 * another origin. An empty `messageId` is likewise dropped rather than
 * emitted, so the notification lands at the room's bottom instead of
 * `?message=` with nothing to highlight — the same place a digest push lands.
 */
export function routeFromEvent(event: unknown): NativePushRoute | null {
  const data =
    typeof event === "object" && event !== null && "data" in event
      ? event.data
      : undefined;
  const candidates: unknown[] = [event, data];
  for (const source of [event, data]) {
    if (typeof source !== "object" || source === null) continue;
    if (!("roomy" in source) || typeof source.roomy !== "string") continue;
    try {
      candidates.push(JSON.parse(source.roomy));
    } catch {
      // Malformed JSON in `roomy` is not fatal — fall through to the other
      // candidates, and ultimately to "no route".
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const spaceId = "spaceId" in candidate ? candidate.spaceId : undefined;
    const roomId = "roomId" in candidate ? candidate.roomId : undefined;
    if (typeof spaceId !== "string" || spaceId.trim() === "") continue;
    if (typeof roomId !== "string" || roomId.trim() === "") continue;
    const rawMessageId = "messageId" in candidate ? candidate.messageId : undefined;
    const messageId =
      typeof rawMessageId === "string" && rawMessageId.trim() !== ""
        ? rawMessageId
        : undefined;
    return {
      spaceId,
      roomId,
      ...(messageId !== undefined ? { messageId } : {}),
    };
  }
  return null;
}

/** The route a room lives at, with its message anchor when it names one. */
export function routeHref(route: NativePushRoute): string {
  const query = route.messageId
    ? `?message=${encodeURIComponent(route.messageId)}`
    : "";
  return `/${encodeURIComponent(route.spaceId)}/${encodeURIComponent(route.roomId)}${query}`;
}
