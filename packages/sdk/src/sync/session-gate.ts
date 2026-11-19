/**
 * The session layer's verdict on this client, and the event that says it
 * changed.
 *
 * A connection ticket is not minted for free: `space.roomy.auth.getConnectionTicket`
 * is authorised by a service-auth token, which the session origin issues, so
 * every connect attempt costs one session request. When the session origin has
 * refused that token, the ticket fetch cannot start succeeding by being
 * attempted again — a reconnect loop that keeps its normal backoff spends one
 * refused session request per interval for as long as the client stays open,
 * and no number of retries can tell it the session is still dead.
 *
 * A gate carries the verdict from the layer that owns the session (which is
 * the only layer that can see the session origin refuse, or accept, a
 * request) to the layer that would otherwise retry:
 *
 *  - the session layer calls {@link SessionGate.reject} when it sees the
 *    origin refuse this client's token;
 *  - the connection suspends its reconnect loop while the mark stands
 *    ({@link SessionGate.rejected});
 *  - the session layer calls {@link SessionGate.recover} on the first
 *    evidence the session works again — a response the origin answered — and
 *    the loop resumes.
 *
 * Recovery is a signal, never a timer: nothing here polls the network to find
 * out whether the session came back, and a client whose session never
 * recovers never spends another session request on it.
 */

/** HTTP status a session origin refuses this client's token with. */
const SESSION_REJECTION_STATUS = 401;

/** The status an error carries, or `null` if it carries none. */
function errorStatus(err: object): number | null {
  if (!("status" in err)) return null;
  const status = err.status;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  return null;
}

/**
 * True when `err` is the session origin refusing this client's token.
 *
 * The session origin is the only thing that answers a 401 *before* an XRPC
 * call is made, so a rejection surfaces as an error carrying a `status` and no
 * `nsid`. A 401 an appserver call produced is a different thing — per-resource
 * authorization, an answer to a question about one room — and
 * `DirectXrpcClient`'s `toXrpcError` stamps every one of those with the `nsid`
 * it answered. That field is the discriminator.
 *
 * A `0` (no response at all) is deliberately *not* a rejection: the network
 * came back empty, the session was never asked, and retrying is the only way
 * to learn anything.
 */
export function isSessionRejected(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("nsid" in err && err.nsid != null) return false;
  return errorStatus(err) === SESSION_REJECTION_STATUS;
}

/**
 * Whether the session can currently mint the tokens this client's requests
 * need, plus the subscription that reports the moment it can again.
 *
 * The verdict is only ever as fresh as the last thing the session layer
 * observed: a client that makes no session requests cannot learn the session
 * recovered, and does not need to — the request that proves it is also the
 * request that resumes the loop.
 */
export class SessionGate {
  #rejected = false;
  readonly #recoverHandlers = new Set<() => void>();

  /** True while every session request is expected to be refused. */
  get rejected(): boolean {
    return this.#rejected;
  }

  /** Record that the session origin refused this client's token. */
  reject(): void {
    this.#rejected = true;
  }

  /**
   * Record that the session works again: the origin answered a request.
   *
   * Idempotent, so a caller can report every accepted request without
   * tracking whether the gate was already open.
   */
  recover(): void {
    if (!this.#rejected) return;
    this.#rejected = false;
    // Copy first: a handler may subscribe or unsubscribe while running.
    for (const handler of [...this.#recoverHandlers]) handler();
  }

  /** Run `handler` after the next `recover()`. Returns an unsubscribe. */
  onRecover(handler: () => void): () => void {
    this.#recoverHandlers.add(handler);
    return () => {
      this.#recoverHandlers.delete(handler);
    };
  }
}
