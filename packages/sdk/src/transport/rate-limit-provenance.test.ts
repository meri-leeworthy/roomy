/**
 * Provenance of a 429: which layer answered, and what the response said
 * about itself. The classifier is pure; the capture is exercised through
 * `DirectXrpcClient` so a real `Response` is what builds the error.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyRateLimitRejection,
  RateLimitError,
  type RateLimitRejection,
} from "./errors";
import { withRateLimitRetry } from "./retry";
import { DirectXrpcClient } from "./direct-xrpc";

function rejection(
  overrides: Partial<RateLimitRejection> = {},
): RateLimitRejection {
  return {
    host: "api.roomy.space",
    server: null,
    cfRay: null,
    cfMitigated: null,
    retryAfterSec: null,
    contentType: null,
    bodyPrefix: null,
    ...overrides,
  };
}

/** A 429 `Response` whose `url` names the host the client asked. */
function rateLimitedResponse(
  body: string,
  headers: Record<string, string>,
): Response {
  const resp = new Response(body, { status: 429, headers });
  Object.defineProperty(resp, "url", {
    value: "https://api.roomy.space/xrpc/space.roomy.space.getSpaces",
  });
  return resp;
}

/** A client that never retries, so the first 429 is the thrown error. */
function clientReturning(resp: Response): DirectXrpcClient {
  const client = new DirectXrpcClient(
    "https://api.roomy.space",
    "did:web:api.roomy.space",
  );
  client.setRateLimitRetry({ maxRetries: 0 });
  vi.stubGlobal("fetch", (async () => resp) as unknown as typeof fetch);
  return client;
}

async function queryError(client: DirectXrpcClient): Promise<unknown> {
  return client.query("space.roomy.space.getSpaces", {}).catch((e) => e);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── classifyRateLimitRejection ───────────────────────────────────────────

describe("classifyRateLimitRejection", () => {
  it("names Cloudflare when cf-ray is present", () => {
    expect(
      classifyRateLimitRejection(
        rejection({ cfRay: "8f2c1e9d2e3a4b5c-AMS", server: "cloudflare" }),
      ),
    ).toBe("cloudflare");
  });

  it("prefers cf-ray over a Railway server header", () => {
    expect(
      classifyRateLimitRejection(
        rejection({ cfRay: "8f2c1e9d2e3a4b5c-AMS", server: "railway" }),
      ),
    ).toBe("cloudflare");
  });

  it("names Railway when server says railway and no cf-ray is present", () => {
    expect(classifyRateLimitRejection(rejection({ server: "railway" }))).toBe(
      "railway",
    );
  });

  it("names the edge for an HTML body that names no vendor", () => {
    expect(
      classifyRateLimitRejection(
        rejection({
          contentType: "text/html; charset=utf-8",
          bodyPrefix: "<!DOCTYPE html><title>Too Many Requests</title>",
        }),
      ),
    ).toBe("edge");
  });

  it("names the edge when cf-mitigated marks the rejection", () => {
    expect(
      classifyRateLimitRejection(rejection({ cfMitigated: "challenge" })),
    ).toBe("edge");
  });

  it("is unknown for the appserver's own bare 429", () => {
    expect(
      classifyRateLimitRejection(
        rejection({
          contentType: "application/json",
          bodyPrefix: '{"error":"RateLimitExceeded"}',
        }),
      ),
    ).toBe("unknown");
  });

  it("is unknown when nothing was captured", () => {
    expect(classifyRateLimitRejection(null)).toBe("unknown");
  });
});

// ─── capture from a real Response ─────────────────────────────────────────

describe("RateLimitError provenance", () => {
  it("captures the rejecting response's headers, host, retry-after and body", async () => {
    const client = clientReturning(
      rateLimitedResponse("<!DOCTYPE html><title>Too Many Requests</title>", {
        "retry-after": "17",
        server: "cloudflare",
        "cf-ray": "8f2c1e9d2e3a4b5c-AMS",
        "content-type": "text/html; charset=utf-8",
      }),
    );

    const err = await queryError(client);

    expect(err).toBeInstanceOf(RateLimitError);
    const rateLimit = err as RateLimitError;
    expect(rateLimit.retryAfterSec).toBe(17);
    expect(rateLimit.rejection).toEqual({
      host: "api.roomy.space",
      server: "cloudflare",
      cfRay: "8f2c1e9d2e3a4b5c-AMS",
      cfMitigated: null,
      retryAfterSec: 17,
      contentType: "text/html; charset=utf-8",
      bodyPrefix: "<!DOCTYPE html><title>Too Many Requests</title>",
    });
    expect(classifyRateLimitRejection(rateLimit.rejection)).toBe("cloudflare");
  });

  it("keeps only the first 200 bytes of the body", async () => {
    const client = clientReturning(
      rateLimitedResponse("x".repeat(500), { "content-type": "text/plain" }),
    );

    const err = (await queryError(client)) as RateLimitError;

    expect(err.rejection?.bodyPrefix).toHaveLength(200);
  });

  it("records no body when the body read fails, without changing the error", async () => {
    const resp = rateLimitedResponse("ignored", { "retry-after": "5" });
    resp.text = async () => {
      throw new Error("body stream closed");
    };
    const client = clientReturning(resp);

    const err = (await queryError(client)) as RateLimitError;

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSec).toBe(5);
    expect(err.rejection?.bodyPrefix).toBeNull();
    expect(err.rejection?.host).toBe("api.roomy.space");
  });

  it("does not make the retry wrapper retry any differently", async () => {
    const sleeps: number[] = [];
    const rateLimit = new RateLimitError(
      7,
      undefined,
      rejection({ cfRay: "8f2c1e9d2e3a4b5c-AMS" }),
    );
    let calls = 0;

    const value = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls === 1) throw rateLimit;
        return "ok";
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(value).toBe("ok");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7000]);
  });
});
