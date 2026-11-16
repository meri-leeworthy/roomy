/**
 * Worker stand-in that accepts every request and never replies — a wedged DB
 * worker, which is the state a request timeout exists to bound.
 *
 * Runs in a Bun.Worker thread (the `.fixture.ts` suffix keeps `bun test` from
 * collecting it). Pair it with a short `requestTimeoutMs` rather than waiting
 * out the real 30s budget.
 */

self.onmessage = () => {};
