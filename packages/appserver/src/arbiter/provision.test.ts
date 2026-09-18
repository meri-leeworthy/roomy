/**
 * Regression test: space provisioning must use the arbiter's built-in
 * owner/manager proxy route, not a scoped `*.arbiter.proxy` route.
 *
 * Why (production outage): the scoped route
 * (`space.roomy.authComplete.arbiter.proxy`) applies two gates before the
 * policy pipeline runs —
 *
 *   1. a trusted-scope gate on the account's config record, then
 *   2. the *permission-set lexicon's* embedded Rego, evaluated over the inner
 *      request core alone (no caller DID — scope policies are pure functions
 *      of `{method, nsid, parameters, body, encoding}`).
 *
 * The published permission set for `space.roomy.authComplete` allows only
 * NSIDs starting with `space.roomy` / `network.cosmic`, plus
 * `com.atproto.repo.uploadBlob`, `com.atproto.identity.updateHandle`, and a
 * `putRecord` of an `app.bsky.actor.profile`. `provisionSpace` step 3 proxies
 * a `putRecord` of `space.roomy.service/self` — an inner NSID of
 * `com.atproto.repo.putRecord` with a `space.roomy.service` collection — which
 * the scope policy denies outright with
 * `403 {"error":"Forbidden","message":"request denied by scope policy"}`.
 *
 * The denial fires before any policy layer, so no admin/recovery-admin
 * authorization can rescue it: every `createSpace` proxied through the scoped
 * route 500s. The built-in `town.muni.arbiter.proxy` route has no scope gate
 * and reaches the pipeline, where the installed default policy admits the
 * account's recovery admin (the appserver) — which is the appserver's
 * authority model for provisioning.
 *
 * The mock arbiter below reproduces the real server's routing: it applies the
 * scope policy on the scoped route (transcribed from the published lexicon,
 * see `SCOPED_SCOPE_POLICY` below) and the ownership check on the built-in
 * route. Pre-fix this test fails at step 3 with the real denial message.
 *
 * Run: bun test --cwd packages/appserver src/arbiter/provision.test.ts
 */

import { beforeEach, expect, test } from "bun:test";
import { provisionSpace } from "./provision.ts";
import { _resetAppserverSigningKey } from "../auth/serviceAuth.ts";
import type { ArbiterConfig } from "./config.ts";
import { StreamDid } from "@roomy-space/sdk";

const OWN_DID = "did:web:api.roomy.space";
const ARBITER_DID = "did:web:arbiter.example";
const NEW_SPACE_DID = "did:plc:provisioned-space";

/** The scoped route the appserver must NOT provision through. */
const SCOPED_ROUTE = "space.roomy.authComplete.arbiter.proxy";
/** The built-in owner/manager route the appserver provisions through. */
const BUILTIN_ROUTE = "town.muni.arbiter.proxy";

/**
 * The scope policy embedded in the published permission-set lexicon
 * `space.roomy.authComplete` (writer `did:plc:cyqufxsezk33hqulcilckna6`, read
 * from its PDS). Transcribed verbatim — the real server compiles this Rego and
 * requires `data.arbiter.allow == true`; the transcription is a direct
 * predicate translation of its `allow` rules.
 */
function scopedScopePolicyAllows(inner: {
  nsid: string;
  body: { collection?: unknown } | null;
}): boolean {
  if (inner.nsid.startsWith("space.roomy")) return true;
  if (inner.nsid.startsWith("network.cosmic")) return true;
  if (inner.nsid === "com.atproto.repo.uploadBlob") return true;
  if (inner.nsid === "com.atproto.identity.updateHandle") return true;
  return (
    inner.nsid === "com.atproto.repo.putRecord" &&
    inner.body?.collection === "app.bsky.actor.profile"
  );
}

interface ProxyEnvelope {
  arbiterDid: string;
  target: string;
  method: string;
  nsid: string;
  parameters?: unknown;
  body?: { collection?: unknown } | null;
}

interface MockArbiter {
  config: ArbiterConfig;
  /** Routes actually hit, in order. */
  calls: string[];
  /** Inner XRPC NSIDs actually proxied. */
  proxiedNsids: string[];
  stop: () => void;
}

/**
 * A mock arbiter that routes like the real server: the scoped route runs the
 * trusted-scope gate + the permission-set scope policy; the built-in route
 * runs the community pipeline (here: the recovery-admin/owner check the
 * installed default policy performs).
 */
function startMockArbiter(): MockArbiter {
  const calls: string[] = [];
  const proxiedNsids: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace(/^\/xrpc\//, "");
      calls.push(route);

      if (route === "town.muni.arbiter.createArbiter") {
        return Response.json({ did: NEW_SPACE_DID });
      }
      if (route === "town.muni.arbiter.resetConfig") {
        return Response.json({ ok: true });
      }
      if (route !== SCOPED_ROUTE && route !== BUILTIN_ROUTE) {
        return new Response("not found", { status: 404 });
      }

      const envelope = (await req.json()) as ProxyEnvelope;
      proxiedNsids.push(envelope.nsid);

      // The account's config record trusts `space.roomy.authComplete` (it is
      // `REFERENCE_ARBITER_CONFIG.trustedScopes`), so the trusted-scope gate
      // passes and the permission-set scope policy decides.
      if (route === SCOPED_ROUTE) {
        if (
          !scopedScopePolicyAllows({
            nsid: envelope.nsid,
            body: envelope.body ?? null,
          })
        ) {
          return Response.json(
            { error: "Forbidden", message: "request denied by scope policy" },
            { status: 403 },
          );
        }
      }
      // Built-in route: the pipeline ran and the owner/recovery-admin was
      // admitted, so the request is proxied as the steward.
      return Response.json({ ok: true });
    },
  });

  return {
    config: { url: `http://127.0.0.1:${server.port}`, did: ARBITER_DID },
    calls,
    proxiedNsids,
    stop: () => server.stop(true),
  };
}

beforeEach(() => {
  _resetAppserverSigningKey();
  process.env.DATA_DIR = "/tmp/appserver-test-data";
  delete process.env.APPSERVER_SIGNING_KEY;
});

test("provisionSpace succeeds — step 3 proxies via the built-in owner route", async () => {
  const mock = startMockArbiter();
  try {
    const spaceDid = await provisionSpace(mock.config, OWN_DID);

    expect(spaceDid).toBe(StreamDid.assert(NEW_SPACE_DID));
    // The provisioning write landed as an inner XRPC through the arbiter.
    expect(mock.proxiedNsids).toContain("com.atproto.repo.putRecord");
    // It must go through the owner route: the scoped route's permission-set
    // scope policy denies this putRecord, which is the production outage.
    expect(mock.calls).toContain(BUILTIN_ROUTE);
    expect(mock.calls).not.toContain(SCOPED_ROUTE);
  } finally {
    mock.stop();
  }
});

test("the provisioning write is denied by the scoped route's scope policy", async () => {
  const mock = startMockArbiter();
  try {
    // Send provisionSpace's exact step-3 inner request over the scoped route
    // and show the deny is structural, not a config/auth failure: the same
    // envelope is refused by the scope policy no matter who calls it, because
    // scope policies cannot see the caller.
    const res = await fetch(`${mock.config.url}/xrpc/${SCOPED_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arbiterDid: NEW_SPACE_DID,
        target: `${NEW_SPACE_DID}#atproto_pds`,
        method: "POST",
        nsid: "com.atproto.repo.putRecord",
        body: {
          repo: NEW_SPACE_DID,
          collection: "space.roomy.service",
          rkey: "self",
          record: { $type: "space.roomy.service", did: OWN_DID },
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden",
      message: "request denied by scope policy",
    });
  } finally {
    mock.stop();
  }
});
