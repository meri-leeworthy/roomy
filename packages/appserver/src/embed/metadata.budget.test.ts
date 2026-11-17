/**
 * Budget and bound tests for the enrichment fetch path.
 *
 * Each test runs a local HTTP server and measures real elapsed time against
 * the real network stack, because the property under test IS wall-clock: a
 * whole enrichment (page fetch + oEmbed call) must finish inside one budget,
 * and no response body may be buffered past the cap. Fake timers cannot drive
 * an in-flight socket read, so these tests deliberately use real delays —
 * each one is a few hundred milliseconds, and each asserts a bound, never a
 * guessed duration. The pure extraction helpers are covered in
 * `metadata.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLinkMetadataHandler } from "../handlers/space.roomy.embed.getLinkMetadata.ts";
import { probeLinkMetadata, type ProbeResult } from "./metadata.ts";

const enc = new TextEncoder();
// Generous enough that a loaded CI runner's late timer still lands inside the
// bound, tight enough that two budgets in series (the regression) never do.
const BUDGET_MS = 1000;
const SLACK_MS = 400;
const CAP_BYTES = 2048;

const OG_HEAD =
  `<html><head>` +
  `<meta property="og:title" content="Head Title" />` +
  `<meta property="og:description" content="Head Description" />`;
const OG_TAIL = `<meta property="og:site_name" content="TAIL-MARKER" /></head></html>`;

/** The head, then 2 MiB of filler, then a tail marker — 4096 chunks of 512. */
function largeStream(prefix: string): ReadableStream<Uint8Array> {
  const filler = enc.encode("A".repeat(512));
  const CHUNKS = 4096;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(prefix));
    },
    pull(controller) {
      if (sent >= CHUNKS) {
        controller.close();
        return;
      }
      controller.enqueue(sent === CHUNKS - 1 ? enc.encode(OG_TAIL) : filler);
      sent++;
    },
  });
}

/** One byte every 25 ms, unbounded — only the deadline ends this body. */
function dripStream(intervalMs: number): ReadableStream<Uint8Array> {
  const byte = enc.encode("A");
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(intervalMs);
      controller.enqueue(byte);
    },
  });
}

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;

    switch (url.pathname) {
      case "/fast":
        return new Response(OG_HEAD + `</head><body>ok</body></html>`, {
          headers: { "content-type": "text/html" },
        });

      // Page answers at 400 ms; the oEmbed endpoint it advertises answers at
      // 2 s. Sequentially that is 2.4 s, past the 1 s total budget.
      case "/slow-page":
        return (async () => {
          await Bun.sleep(400);
          return new Response(
            OG_HEAD +
              `<link rel="alternate" type="application/json+oembed" href="${origin}/slow-oembed" />` +
              `</head><body>slow</body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        })();

      case "/slow-oembed":
        return (async () => {
          await Bun.sleep(2000);
          return Response.json({ title: "OEmbed Title", provider_name: "P" });
        })();

      // Never answers; the request only ends when the client gives up.
      case "/hang":
        return new Promise<Response>((resolve) => {
          req.signal.addEventListener(
            "abort",
            () => resolve(new Response("aborted", { status: 499 })),
            { once: true },
          );
        });

      case "/huge-page":
        return new Response(largeStream(OG_HEAD), {
          headers: { "content-type": "text/html" },
        });

      case "/big-oembed-page":
        return new Response(
          OG_HEAD +
            `<link rel="alternate" type="application/json+oembed" href="${origin}/big-oembed" />` +
            `</head><body>big</body></html>`,
          { headers: { "content-type": "text/html" } },
        );

      // A JSON body far past the cap: truncated, so it can never parse.
      case "/big-oembed":
        return new Response(
          `{"provider_name":"BigProvider","title":"${"x".repeat(200 * 1024)}"}`,
          { headers: { "content-type": "application/json" } },
        );

      case "/drip":
        return new Response(dripStream(25), {
          headers: { "content-type": "text/html" },
        });

      default:
        return new Response("not found", { status: 404 });
    }
  },
});

const base = `http://127.0.0.1:${server.port}`;

const savedBudget = process.env.EMBED_METADATA_TIMEOUT_MS;
const savedCap = process.env.EMBED_METADATA_MAX_BYTES;

beforeEach(() => {
  process.env.EMBED_METADATA_TIMEOUT_MS = String(BUDGET_MS);
  process.env.EMBED_METADATA_MAX_BYTES = String(CAP_BYTES);
});

afterEach(() => {
  if (savedBudget === undefined) delete process.env.EMBED_METADATA_TIMEOUT_MS;
  else process.env.EMBED_METADATA_TIMEOUT_MS = savedBudget;
  if (savedCap === undefined) delete process.env.EMBED_METADATA_MAX_BYTES;
  else process.env.EMBED_METADATA_MAX_BYTES = savedCap;
});

afterAll(() => {
  server.stop(true);
});

/** One probe, with the wall-clock it took. */
async function timed(url: string): Promise<{ elapsed: number; result: ProbeResult }> {
  const started = performance.now();
  const result = await probeLinkMetadata(url);
  return { elapsed: performance.now() - started, result };
}

describe("whole-enrichment deadline", () => {
  test("a page that never answers returns inside the total budget", async () => {
    const { elapsed, result } = await timed(`${base}/hang`);
    expect(result.status).toBe("transient");
    expect(elapsed).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 10_000);

  test("a slow page plus a slow oEmbed endpoint cannot sum past the budget", async () => {
    // Page 400 ms + oEmbed 2 s = 2.4 s if the two ran under separate clocks.
    // One deadline covers both, so the oEmbed half is cut at 1 s and the
    // page's OpenGraph data is what the caller gets.
    const { elapsed, result } = await timed(`${base}/slow-page`);
    expect(elapsed).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(result).toEqual({
      status: "ok",
      metadata: { t: "Head Title", d: "Head Description" },
    });
  }, 10_000);

  test("a caller abort stops the outbound fetch early", async () => {
    // A deadline far longer than the test: only the caller's signal can end
    // this fetch, so the bound proves the signal reaches it.
    process.env.EMBED_METADATA_TIMEOUT_MS = "30000";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    const result = await probeLinkMetadata(`${base}/hang`, controller.signal);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
    expect(result.status).toBe("transient");
  }, 10_000);

  test("the getLinkMetadata handler honours the request's abort signal", async () => {
    process.env.EMBED_METADATA_TIMEOUT_MS = "30000";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    const result = await getLinkMetadataHandler(
      { url: `${base}/hang` },
      { did: null },
      controller.signal,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toEqual({});
  }, 10_000);
});

describe("bounded body reads", () => {
  test("an oversized page is cut off at the cap, metadata from the head survives", async () => {
    const { elapsed, result } = await timed(`${base}/huge-page`);
    // An uncapped read never returns: it waits for an end that the deadline
    // brings at 1 s, so this result — not the bound — is what proves the cap.
    expect(elapsed).toBeLessThan(BUDGET_MS * 2);
    expect(result).toEqual({
      status: "ok",
      metadata: { t: "Head Title", d: "Head Description" },
    });
    // TAIL-MARKER is the last 512 bytes of a 2 MiB body: reaching it would
    // mean the body was buffered whole.
    expect(JSON.stringify(result)).not.toContain("TAIL-MARKER");
  }, 10_000);

  test("an oversized oEmbed body yields nothing, so OpenGraph wins", async () => {
    const { elapsed, result } = await timed(`${base}/big-oembed-page`);
    expect(elapsed).toBeLessThan(BUDGET_MS * 4);
    expect(result).toEqual({
      status: "ok",
      metadata: { t: "Head Title", d: "Head Description" },
    });
  }, 10_000);

  test("a drip-fed body cannot hold the budget", async () => {
    const { elapsed, result } = await timed(`${base}/drip`);
    expect(result.status).toBe("transient");
    expect(elapsed).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 10_000);
});
