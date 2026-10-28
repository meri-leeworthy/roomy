import { describe, expect, test, vi } from "bun:test";
import { type } from "arktype";
import { XrpcRouter } from "./router.ts";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

const stubAuth = async (_req: Request): Promise<AuthCtx> => ({
  did: "did:plc:test",
});

function build(register: (r: XrpcRouter) => void): XrpcRouter {
  const r = new XrpcRouter(stubAuth);
  register(r);
  return r;
}

async function call(
  router: XrpcRouter,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const fakeServer = {
    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 }),
  } as unknown as Parameters<typeof router.fetch>[1];
  const res = await router.fetch(new Request(url, init), fakeServer);
  if (!res) throw new Error("router returned no Response");
  return res;
}

describe("XrpcRouter schema validation", () => {
  describe("query", () => {
    const Params = type({ roomId: "string" });
    const Response = type({ messages: "string[]" });

    test("happy path returns 200 with validated body", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          handler: async (params) => ({ messages: [`for-${params.roomId}`] }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query?roomId=abc");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ messages: ["for-abc"] });
    });

    test("input rejection returns 400 with InvalidRequest", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          handler: async () => ({ messages: [] }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query"); // missing roomId
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("InvalidRequest");
      expect(body.message).toContain("test.query params");
    });

    test("output mismatch throws and surfaces as 500", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          // Wrong shape on purpose.
          handler: async () => ({ wrong: "shape" }) as never,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query?roomId=abc");
      expect(res.status).toBe(500);
    });
  });

  describe("procedure", () => {
    const Input = type({ roomId: "string" });
    const Output = type({ ok: "boolean" });

    test("happy path", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          outputSchema: Output,
          handler: async (_p, _a, body: any) => ({
            ok: typeof body.roomId === "string",
          }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test("input rejection returns 400", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          handler: async () => undefined,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("InvalidRequest");
      expect(body.message).toContain("test.proc input");
    });

    test("output mismatch surfaces as 500", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          outputSchema: Output,
          handler: async () => ({ wrong: 1 }) as never,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(500);
    });

    test("void short-circuit (no outputSchema) returns empty 200", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          // No outputSchema — handler returns undefined.
          handler: async () => undefined,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });
  });

  test("routes without schemas pass through unchanged", async () => {
    const router = build((r) =>
      r.query("legacy", {
        handler: async () => ({ anything: 123 }),
      }),
    );
    const res = await call(router, "http://x/xrpc/legacy?anything=goes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anything: 123 });
  });
});

describe("XrpcRouter authenticated-request observer", () => {
  test("reports the caller's DID for a query and for a procedure", async () => {
    const seen: string[] = [];
    const router = build((r) => {
      r.setOnAuthenticated((did) => seen.push(did));
      r.query("test.query", { handler: async () => ({ ok: true }) });
      r.procedure("test.proc", { handler: async () => undefined });
    });

    await call(router, "http://x/xrpc/test.query");
    await call(router, "http://x/xrpc/test.proc", { method: "POST" });

    expect(seen).toEqual(["did:plc:test", "did:plc:test"]);
  });

  test("reports nothing for an anonymous caller", async () => {
    const seen: string[] = [];
    const router = new XrpcRouter(async () => ({ did: null })).query(
      "test.query",
      { handler: async () => ({ ok: true }) },
    );
    router.setOnAuthenticated((did) => seen.push(did));

    await call(router, "http://x/xrpc/test.query");

    expect(seen).toEqual([]);
  });
});

describe("XrpcRouter error attribution", () => {
  /** The `[xrpc]` error record emitted for the last failed request. */
  function xrpcErrors(spy: {
    mock: { calls: unknown[][] };
  }): Record<string, unknown>[] {
    return spy.mock.calls
      .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
      .filter((r) => r["scope"] === "xrpc");
  }

  test("a failure inside a handler logs the caller and the space it named", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = build((r) =>
        r.query("test.query", {
          handler: async () => {
            throw new XrpcError(403, "Forbidden", "no read access");
          },
        }),
      );

      const res = await call(
        router,
        "http://x/xrpc/test.query?spaceId=did:plc:spaceone",
      );
      expect(res.status).toBe(403);

      const [record, ...rest] = xrpcErrors(spy);
      expect(rest).toHaveLength(0);
      expect(record).toMatchObject({
        level: "error",
        scope: "xrpc",
        msg: "GET /xrpc/test.query failed: no read access",
        did: "did:plc:test",
        spaceId: "did:plc:spaceone",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("a failure inside a procedure logs the space named in the body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const Input = type({ spaceId: "string" });
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          handler: async () => {
            throw new XrpcError(403, "Forbidden", "not a member");
          },
        }),
      );

      await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId: "did:plc:spacetwo" }),
      });

      expect(xrpcErrors(spy)[0]).toMatchObject({
        did: "did:plc:test",
        spaceId: "did:plc:spacetwo",
      });
    } finally {
      spy.mockRestore();
    }
  });

  /** A router for one query route that always fails, never authenticating. */
  function failing(handler: () => never): XrpcRouter {
    return new XrpcRouter(async () => ({ did: null })).query("test.query", {
      handler,
    });
  }

  test("an anonymous 401 logs the credential's shape and the caller's User-Agent", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = failing(() => {
        throw new XrpcError(401, "AuthRequired", "Authentication required");
      });

      const res = await call(router, "http://x/xrpc/test.query?spaceId=did:plc:spaceone", {
        headers: { "user-agent": "curl/8.5.0" },
      });
      expect(res.status).toBe(401);

      const record = xrpcErrors(spy)[0]!;
      expect(record["msg"]).toBe(
        "GET /xrpc/test.query failed: Authentication required",
      );
      // The 401 says nothing about whether a credential was offered; the log
      // line has to, or the caller cannot be told apart from a broken client.
      expect(record["auth_header"]).toBe("none");
      expect(record["client"]).toBe("curl/8.5.0");
      // Identity is still an authenticated-caller field only: this request is
      // anonymous, so the spaceId it named is unverified text and is dropped.
      expect("did" in record).toBe(false);
      expect("spaceId" in record).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("a rejected credential is logged as offered, and other schemes distinctly", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = failing(() => {
        throw new XrpcError(401, "InvalidToken", "invalid token");
      });

      await call(router, "http://x/xrpc/test.query", {
        headers: { authorization: "Bearer abc.def.ghi", "user-agent": "Mozilla/5.0" },
      });
      await call(router, "http://x/xrpc/test.query", {
        headers: { authorization: "Basic dXNlcg==" },
      });

      const [bearer, basic, ...rest] = xrpcErrors(spy);
      expect(rest).toHaveLength(0);
      expect(bearer).toMatchObject({
        auth_header: "bearer",
        client: "Mozilla/5.0",
      });
      expect(basic).toMatchObject({ auth_header: "other", client: "none" });
      // Never the credential itself.
      expect(JSON.stringify(bearer)).not.toContain("abc.def.ghi");
    } finally {
      spy.mockRestore();
    }
  });

  test("the caller label is printable and bounded", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = failing(() => {
        throw new XrpcError(401, "AuthRequired", "Authentication required");
      });

      await call(router, "http://x/xrpc/test.query", {
        headers: { "user-agent": `probe\u001b[31m ${"x".repeat(200)}` },
      });

      const client = xrpcErrors(spy)[0]!["client"] as string;
      expect(client.startsWith("probe[31m ")).toBe(true);
      expect(client).toHaveLength(64);
    } finally {
      spy.mockRestore();
    }
  });

  test("a spaceId that is not a DID is not logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = build((r) =>
        r.query("test.query", {
          handler: async () => {
            throw new XrpcError(500, "InternalServerError", "boom");
          },
        }),
      );

      await call(router, "http://x/xrpc/test.query?spaceId=not-a-did");

      const record = xrpcErrors(spy)[0]!;
      expect(record["did"]).toBe("did:plc:test");
      expect("spaceId" in record).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
