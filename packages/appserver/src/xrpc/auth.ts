import { createServiceAuthVerifier } from "@roomy/service-auth";
import { idResolver } from "../identity.ts";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

export type AuthVerifier = (req: Request) => Promise<AuthCtx>;

// ── Production auth verifier ─────────────────────────────────────────────

const OWN_DID = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";

/**
 * Production auth verifier: ATProto service-auth and atproto-proxy JWTs
 * addressed to this appserver.
 *
 * The token check itself lives in `@roomy/service-auth` and is shared with the
 * Discord bridge's REST API. DID documents resolve through identity.ts's
 * shared cache, so an issuer is fetched at most once per cache window per
 * process, and `forceRefresh` (verifyJwt's retry after a signature mismatch)
 * honours a rotated signing key on the token that needs it.
 *
 * No token, or a token that fails verification, is anonymous (`did: null`);
 * handlers decide what anonymous callers may do.
 */
export const prodAuthVerifier: AuthVerifier = createServiceAuthVerifier({
  audience: OWN_DID,
  resolveDid: (did, forceRefresh) => idResolver.did.resolve(did, forceRefresh),
});

// ── Test auth verifier ───────────────────────────────────────────────────

/**
 * Auth verifier for E2E / integration testing. Bypasses JWT verification and
 * PLC DID resolution entirely — the caller's DID is read from a header,
 * `X-Test-Did`, so tests can impersonate any user without a real PDS or
 * network. Never enable in production: it accepts any DID without proof.
 *
 * Behaviour:
 * - `X-Test-Did: <did>`  → authenticated as that DID (no verification).
 * - No header, or empty  → anonymous (`{ did: null }`), same as prod.
 *
 * Guarded by an env flag so importing this module in a non-test process
 * is a no-op. The factory (`createAppserver`) selects this verifier when
 * `APPSERVER_TEST_MODE=true`.
 */
export const testAuthVerifier: AuthVerifier = async (req) => {
  const did = req.headers.get("x-test-did");
  if (!did) return { did: null };
  return { did };
};

/**
 * Select the appropriate auth verifier based on env. Test mode takes
 * precedence so a test harness never accidentally hits the network.
 */
export function selectAuthVerifier(): AuthVerifier {
  if (process.env.APPSERVER_TEST_MODE === "true") return testAuthVerifier;
  return prodAuthVerifier;
}

// ── Ticket store for WebSocket pre-auth ─────────────────────────────────

const tickets = new Map<string, { did: string; expiresAt: number }>();
const TICKET_TTL_MS = 60_000;

setInterval(
  () => {
    const now = Date.now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= now) tickets.delete(ticket);
    }
  },
  5 * 60 * 1000,
).unref();

export function issueTicket(did: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const ticket = Buffer.from(bytes).toString("hex");
  tickets.set(ticket, { did, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

export function consumeTicket(ticket: string): string {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) {
    throw new XrpcError(401, "InvalidToken", "Ticket not found or expired");
  }
  return entry.did;
}
