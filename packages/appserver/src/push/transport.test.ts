/**
 * Transport seam: the dispatcher routes a stored subscription to the transport
 * its `kind` names, and consumes one outcome vocabulary
 * (`delivered`/`gone`/`retry`) from every transport.
 *
 * The seam's whole point is that delivery policy does not know which transport
 * carries a push. These tests pin exactly that: a second transport, registered
 * only by this file, receives the delivery the dispatcher routed to it, and
 * pruning/failure accounting stay in the dispatcher for whichever transport ran.
 *
 * Only stub transports are driven here — a real Web Push delivery would reach a
 * push service, so the registry's Web Push entry is asserted, never invoked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  deliverPayload,
  _resetPushDispatcher,
  pushDispatcherStats,
} from "./dispatcher.ts";
import {
  PUSH_TRANSPORTS,
  type PushDeliveryOptions,
  type PushOutcome,
  type PushTarget,
} from "./transport.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import type { DbLike } from "../db/types.ts";

const USER = "did:plc:transport-user";
/** Kinds this build ships as names but no transport: free for a stub. */
const STUB_KINDS = ["apns", "fcm"] as const;

/** A transport that records what it was asked to deliver. */
interface RecordingTransport {
  calls: Array<{ target: PushTarget; body: string; options: PushDeliveryOptions }>;
}

/** Register a stub for `kind` and return its recorder. */
function stubTransport(kind: string, reply: PushOutcome): RecordingTransport {
  const recorder: RecordingTransport = { calls: [] };
  PUSH_TRANSPORTS[kind] = {
    kind: kind as (typeof STUB_KINDS)[number],
    async deliver(target, body, options) {
      recorder.calls.push({ target, body, options });
      return reply;
    },
  };
  return recorder;
}

afterEach(() => {
  _resetPushDispatcher();
  for (const kind of STUB_KINDS) delete PUSH_TRANSPORTS[kind];
});

/** Minimal read-state DB carrying just the subscription table. */
function freshDb(): DbLike {
  const raw = new Database(":memory:");
  raw.exec(`create table push_subscriptions (
    user_did text not null, endpoint text not null,
    kind text not null default 'webpush',
    p256dh text not null, auth text not null,
    expiration_time integer,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    primary key (user_did, endpoint)
  ) strict;`);
  return raw as unknown as DbLike;
}

const PAYLOAD = {
  type: "message" as const,
  spaceId: "did:plc:space",
  roomId: "01ROOM0000000000000000000",
  count: 1,
};

describe("push/transport — delivery seam", () => {
  test("webpush is a registered transport (the first implementation)", () => {
    expect(PUSH_TRANSPORTS.webpush?.kind).toBe("webpush");
  });

  test("a subscription is routed to the transport its kind names", async () => {
    const db = freshDb();
    const stub = stubTransport("apns", { outcome: "delivered", status: 200 });
    await upsertSubscription(db, {
      userDid: USER,
      endpoint: "device-token-abc",
      kind: "apns",
      expirationTime: null,
    });

    await deliverPayload(db, USER, PAYLOAD);

    // The non-Web-Push transport received the delivery the dispatcher routed.
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.target.kind).toBe("apns");
    expect(call.target.endpoint).toBe("device-token-abc");
    expect(JSON.parse(call.body)).toEqual(PAYLOAD);
    // Per-room coalescing reaches the transport (it maps this to its own
    // collapse key), so routing carries policy rather than bypassing it.
    expect(call.options.topic).toBeString();
    expect(pushDispatcherStats().deliveredOk).toBe(1);
  });

  test("kind selects the transport: a row reaches only its own transport", async () => {
    const db = freshDb();
    const apns = stubTransport("apns", { outcome: "delivered", status: 200 });
    const fcm = stubTransport("fcm", { outcome: "delivered", status: 200 });
    await upsertSubscription(db, {
      userDid: USER,
      endpoint: "android-device-token",
      kind: "fcm",
      expirationTime: null,
    });

    await deliverPayload(db, USER, PAYLOAD);

    expect(fcm.calls).toHaveLength(1);
    expect(apns.calls).toHaveLength(0);
  });

  test("gone prunes the row, whichever transport reported it", async () => {
    const db = freshDb();
    stubTransport("apns", { outcome: "gone", status: 410 });
    await upsertSubscription(db, {
      userDid: USER,
      endpoint: "stale-device-token",
      kind: "apns",
      expirationTime: null,
    });

    await deliverPayload(db, USER, PAYLOAD);

    const rows = await db
      .query("select endpoint from push_subscriptions where user_did = ?")
      .all<{ endpoint: string }>(USER);
    expect(rows).toHaveLength(0);
    expect(pushDispatcherStats().gone).toBe(1);
  });

  test("retry keeps the row and counts a failure", async () => {
    const db = freshDb();
    stubTransport("apns", { outcome: "retry", status: 429, error: new Error("429") });
    await upsertSubscription(db, {
      userDid: USER,
      endpoint: "rate-limited-device",
      kind: "apns",
      expirationTime: null,
    });

    await deliverPayload(db, USER, PAYLOAD);

    const rows = await db
      .query("select endpoint from push_subscriptions where user_did = ?")
      .all<{ endpoint: string }>(USER);
    expect(rows).toHaveLength(1);
    expect(pushDispatcherStats().failed).toBe(1);
  });

  test("a row whose transport is not registered is counted, not dropped silently", async () => {
    const db = freshDb();
    await upsertSubscription(db, {
      userDid: USER,
      endpoint: "token-for-absent-transport",
      kind: "fcm",
      expirationTime: null,
    });

    await deliverPayload(db, USER, PAYLOAD);

    // The row survives (the transport may exist in a later build) and the gap
    // is visible in the failure counter.
    expect(pushDispatcherStats().failed).toBe(1);
    const rows = await db
      .query("select endpoint from push_subscriptions where user_did = ?")
      .all<{ endpoint: string }>(USER);
    expect(rows).toHaveLength(1);
  });
});
