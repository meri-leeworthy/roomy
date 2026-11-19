/**
 * Unit tests for the session gate: the rule that separates a session origin
 * refusing this client's token from every other failed request, and the
 * reject/recover signal the reconnect loop waits on.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionGate, isSessionRejected } from "./session-gate";

describe("isSessionRejected", () => {
  it("accepts a bare 401, which is the session origin's answer", () => {
    expect(isSessionRejected(Object.assign(new Error("unauthorized"), { status: 401 })))
      .toBe(true);
    // Some transports stringify the status.
    expect(isSessionRejected(Object.assign(new Error("unauthorized"), { status: "401" })))
      .toBe(true);
  });

  it("rejects a 401 that names the NSID it answered for", () => {
    // An appserver 401 is per-resource authorization, not a dead session.
    expect(
      isSessionRejected(
        Object.assign(new Error("forbidden"), {
          status: 401,
          nsid: "space.roomy.room.getMessages",
        }),
      ),
    ).toBe(false);
  });

  it("rejects every failure that is not a 401", () => {
    expect(isSessionRejected(Object.assign(new Error("server"), { status: 500 }))).toBe(false);
    // status 0 is no response at all: the session was never asked.
    expect(isSessionRejected(Object.assign(new Error("network"), { status: 0 }))).toBe(false);
    expect(isSessionRejected(new Error("network"))).toBe(false);
    expect(isSessionRejected(null)).toBe(false);
    expect(isSessionRejected("401")).toBe(false);
  });
});

describe("SessionGate", () => {
  it("reports rejections and wakes subscribers on recovery", () => {
    const gate = new SessionGate();
    const recovered = vi.fn();
    gate.onRecover(recovered);

    expect(gate.rejected).toBe(false);
    gate.reject();
    expect(gate.rejected).toBe(true);
    expect(recovered).not.toHaveBeenCalled();

    gate.recover();
    expect(gate.rejected).toBe(false);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("does not fire on a recovery it was not told about", () => {
    const gate = new SessionGate();
    const recovered = vi.fn();
    gate.onRecover(recovered);

    // Every accepted session request can report itself without tracking state.
    gate.recover();

    expect(recovered).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const gate = new SessionGate();
    const recovered = vi.fn();
    const unsubscribe = gate.onRecover(recovered);

    unsubscribe();
    gate.reject();
    gate.recover();

    expect(recovered).not.toHaveBeenCalled();
  });
});
