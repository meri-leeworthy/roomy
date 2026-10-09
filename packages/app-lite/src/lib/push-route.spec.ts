import { describe, expect, it } from "vitest";

import { routeFromEvent, routeHref } from "./push-route";

/**
 * The native plugin delivers `{ title?, body?, data }`, where `data` holds the
 * APNs payload's non-`aps` keys (iOS) or the FCM data map (Android). The
 * appserver puts its own payload — `{ type, spaceId, roomId, messageId?, … }` —
 * under `roomy` as a JSON *string*, so these fixtures mirror exactly what
 * `apn.ts`/`fcm.ts` send and what the plugin's platform code projects.
 */
function nativeEvent(roomy: unknown): { data: Record<string, unknown> } {
  return {
    data: {
      roomy: typeof roomy === "string" ? roomy : JSON.stringify(roomy),
    },
  };
}

/** A message push, as `evaluate.ts` builds it. */
const MESSAGE_PAYLOAD = {
  type: "message",
  spaceId: "space-1",
  roomId: "room-1",
  messageId: "msg-1",
  count: 1,
  roomName: "lobby",
};

/** A digest push: a batch of messages in one room, so no single anchor. */
const DIGEST_PAYLOAD = {
  type: "digest",
  spaceId: "space-1",
  roomId: "room-1",
  count: 7,
  roomName: "lobby",
};

describe("routeFromEvent", () => {
  it("reads the route out of the `roomy` string the transports send", () => {
    expect(routeFromEvent(nativeEvent(MESSAGE_PAYLOAD))).toEqual({
      spaceId: "space-1",
      roomId: "room-1",
      messageId: "msg-1",
    });
  });

  it("routes a digest to the room without a message anchor", () => {
    expect(routeFromEvent(nativeEvent(DIGEST_PAYLOAD))).toEqual({
      spaceId: "space-1",
      roomId: "room-1",
    });
  });

  it("accepts the route when it is the data map itself", () => {
    // Android puts the payload's keys straight on the FCM data map, and a
    // future transport could nest the payload as an object rather than a
    // string; both are read the same way.
    expect(routeFromEvent({ data: MESSAGE_PAYLOAD })).toEqual({
      spaceId: "space-1",
      roomId: "room-1",
      messageId: "msg-1",
    });
  });

  it("prefers the parsed payload over the raw data map", () => {
    const event = {
      data: { roomy: JSON.stringify(MESSAGE_PAYLOAD), spaceId: "wrong" },
    };
    expect(routeFromEvent(event)?.spaceId).toBe("space-1");
  });

  it("yields no route for a payload with no ids", () => {
    expect(routeFromEvent(nativeEvent({ type: "message", count: 1 }))).toBeNull();
  });

  it("yields no route for an empty id", () => {
    // `spaceId` is resolved from a materialised row, so `""` means the lookup
    // missed. Rendering it would navigate to `//room-1`, which a router reads
    // as a protocol-relative URL on another origin.
    expect(routeFromEvent(nativeEvent({ ...MESSAGE_PAYLOAD, spaceId: "" }))).toBeNull();
    expect(routeFromEvent(nativeEvent({ ...MESSAGE_PAYLOAD, roomId: "  " }))).toBeNull();
  });

  it("drops an empty message anchor rather than emitting it", () => {
    // `?message=` with nothing to highlight would leave the room scrolled to
    // its bottom with a highlight that never resolves.
    expect(routeFromEvent(nativeEvent({ ...MESSAGE_PAYLOAD, messageId: "" }))).toEqual({
      spaceId: "space-1",
      roomId: "room-1",
    });
  });

  it("ignores a non-string message anchor", () => {
    expect(routeFromEvent(nativeEvent({ ...MESSAGE_PAYLOAD, messageId: 42 }))).toEqual({
      spaceId: "space-1",
      roomId: "room-1",
    });
  });

  it("yields no route for malformed JSON in `roomy`", () => {
    expect(routeFromEvent(nativeEvent("{not json"))).toBeNull();
  });

  it("yields no route for an event with no data at all", () => {
    expect(routeFromEvent(undefined)).toBeNull();
    expect(routeFromEvent(null)).toBeNull();
    expect(routeFromEvent({})).toBeNull();
    expect(routeFromEvent({ title: "hi", body: "there" })).toBeNull();
  });
});

describe("routeHref", () => {
  it("appends the message anchor when the payload names one", () => {
    expect(
      routeHref({ spaceId: "space-1", roomId: "room-1", messageId: "msg-1" }),
    ).toBe("/space-1/room-1?message=msg-1");
  });

  it("omits the query for a digest, landing at the room's bottom", () => {
    expect(routeHref({ spaceId: "space-1", roomId: "room-1" })).toBe(
      "/space-1/room-1",
    );
  });

  it("escapes an id so a crafted payload cannot add path or query", () => {
    expect(routeHref({ spaceId: "s", roomId: "r", messageId: "a&b=c" })).toBe(
      "/s/r?message=a%26b%3Dc",
    );
    expect(routeHref({ spaceId: "s", roomId: "../x", messageId: "m" })).toBe(
      "/s/..%2Fx?message=m",
    );
  });
});
