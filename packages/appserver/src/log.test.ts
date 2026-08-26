/**
 * Unit tests for the structured logger: JSON shape, level gating, scope
 * parsing, error serialization, and the build_id fallback chain.
 *
 * The Loki sink is replaced with a mock in beforeEach so tests never touch
 * the network; the stdout sink is asserted via console spyOn.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { log, _setLokiSink } from "./log.ts";
import { resolveBuildId } from "./telemetry/build.ts";
import type { LokiSink } from "./telemetry/loki.ts";

let origLogLevel: string | undefined;
let origBuildId: string | undefined;
let origGitSha: string | undefined;
let origAlloyUrl: string | undefined;
let origReplicaId: string | undefined;
let origServiceName: string | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;
interface MockLokiSink extends LokiSink {
  records: { line: string; labels: Record<string, string>; ts: number }[];
}

let mockSink: MockLokiSink;

function makeMockSink(): MockLokiSink {
  const records: { line: string; labels: Record<string, string>; ts: number }[] = [];
  return {
    push: (r) => records.push(r),
    flush: async () => {},
    stop: () => {},
    stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
    records,
  };
}

beforeEach(() => {
  origLogLevel = process.env.LOG_LEVEL;
  origBuildId = process.env.BUILD_ID;
  origGitSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  origAlloyUrl = process.env.ALLOY_URL;
  origReplicaId = process.env.RAILWAY_REPLICA_ID;
  origServiceName = process.env.RAILWAY_SERVICE_NAME;
  delete process.env.BUILD_ID;
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
  delete process.env.ALLOY_URL;
  delete process.env.RAILWAY_REPLICA_ID;
  delete process.env.RAILWAY_SERVICE_NAME;
  process.env.LOG_LEVEL = "info";

  stdoutSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

  mockSink = makeMockSink();
  _setLokiSink(mockSink);
});

afterEach(() => {
  _setLokiSink(null);
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
  if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = origLogLevel;
  if (origBuildId === undefined) delete process.env.BUILD_ID;
  else process.env.BUILD_ID = origBuildId;
  if (origGitSha === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = origGitSha;
  if (origAlloyUrl === undefined) delete process.env.ALLOY_URL;
  else process.env.ALLOY_URL = origAlloyUrl;
  if (origReplicaId === undefined) delete process.env.RAILWAY_REPLICA_ID;
  else process.env.RAILWAY_REPLICA_ID = origReplicaId;
  if (origServiceName === undefined) delete process.env.RAILWAY_SERVICE_NAME;
  else process.env.RAILWAY_SERVICE_NAME = origServiceName;
});

describe("structured JSON output", () => {
  test("info line emits one valid JSON object with ts/level/scope/msg/build_id/service", () => {
    log.info("startup", "appserver ready", { port: 8080 });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = stdoutSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.level).toBe("info");
    expect(parsed.scope).toBe("startup");
    expect(parsed.msg).toBe("appserver ready");
    expect(parsed.port).toBe(8080);
    expect(parsed.build_id).toBe("unknown");
    expect(parsed.service).toBe("appserver");
  });

  test("[scope] prefix becomes the scope field", () => {
    log.warn("[embed-sweeper] DB error: boom", new Error("boom"));

    const line = (warnSpy.mock.calls[0]![0] as string);
    const parsed = JSON.parse(line);
    expect(parsed.scope).toBe("embed-sweeper");
    expect(parsed.msg).toBe("DB error: boom");
    expect(parsed.error.message).toBe("boom");
    expect(parsed.error.stack).toBeTypeOf("string");
  });

  test("trailing Error is serialized as error field", () => {
    log.error("appserver close: server.stop failed", new Error("stop"));

    const line = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("error");
    expect(parsed.scope).toBe("app");
    expect(parsed.msg).toBe("appserver close: server.stop failed");
    expect(parsed.error.message).toBe("stop");
  });

  test("extra fields from the log call are spread into the record", () => {
    log.info("sendEvents", "done", { spaceId: "did:plc:x", count: 3 });

    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.spaceId).toBe("did:plc:x");
    expect(parsed.count).toBe(3);
  });
});

describe("level gating", () => {
  test("debug is dropped at LOG_LEVEL=info", () => {
    log.debug("startup", "verbose detail");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("warn and error pass at LOG_LEVEL=info", () => {
    log.warn("startup", "warning");
    log.error("startup", "failure");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test("debug passes at LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    log.debug("startup", "verbose detail");
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe("build_id fallback chain", () => {
  test("BUILD_ID wins", () => {
    process.env.BUILD_ID = "abc12345";
    process.env.RAILWAY_GIT_COMMIT_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(resolveBuildId()).toBe("abc12345");
  });

  test("RAILWAY_GIT_COMMIT_SHA is the fallback", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(resolveBuildId()).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  test("unknown when neither is set", () => {
    expect(resolveBuildId()).toBe("unknown");
  });

  test("build_id on the record follows the chain", () => {
    process.env.BUILD_ID = "abc12345";
    log.info("startup", "ready");
    const parsed = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(parsed.build_id).toBe("abc12345");
  });
});

describe("Loki sink wiring", () => {
  test("records are pushed to the Loki sink with labels", () => {
    log.info("startup", "ready", { port: 8080 });

    expect(mockSink.records).toHaveLength(1);
    const rec = mockSink.records[0]!;
    expect(rec.labels.service_name).toBe("appserver");
    expect(rec.labels.level).toBe("info");
    expect(rec.labels.scope).toBe("startup");
    const parsed = JSON.parse(rec.line);
    expect(parsed.msg).toBe("ready");
    expect(parsed.port).toBe(8080);
    expect(parsed.build_id).toBe("unknown");
  });

  test("RAILWAY_REPLICA_ID and RAILWAY_SERVICE_NAME become stream labels", () => {
    process.env.RAILWAY_REPLICA_ID = "replica-1";
    process.env.RAILWAY_SERVICE_NAME = "appserver-prod";
    log.info("startup", "ready");

    const rec = mockSink.records[0]!;
    expect(rec.labels.replica_id).toBe("replica-1");
    expect(rec.labels.railway_service_name).toBe("appserver-prod");
  });

  test("gated records are not pushed to the Loki sink", () => {
    log.debug("startup", "verbose");
    expect(mockSink.records).toHaveLength(0);
  });
});
