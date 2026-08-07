#!/usr/bin/env tsx
/**
 * Canary for the per-space DB split (Phase 1) — verifies the write path
 * lands in all three DBs (monolithic, per-space, global) on a live
 * appserver, and that `space.roomy.admin.checkDualWrite` reports the space
 * consistent. Run it right after a production deploy.
 *
 * Env (same as the CLI):
 *   ATPROTO_IDENTIFIER / ATPROTO_APP_PASSWORD  (app-password login)
 *   ATPROTO_PDS                               (optional; default resolves PDS)
 *   APPSERVER_URL                             (e.g. https://api.roomy.space)
 *   APPSERVER_DID                             (default did:web:api.roomy.space)
 *   CANARY_ADMIN_DID                          (default = logged-in DID; MUST be
 *                                              on APPSERVER_ADMIN_DIDS on prod)
 *   CANARY_SPACE_ID                           (optional: reuse an existing space
 *                                              instead of creating one)
 *   CANARY_CLEANUP                            ("false" keeps the test space)
 *
 * Usage:
 *   cd packages/cli && npx tsx scripts/canary-dual-write.ts
 */
import { newUlid, transport } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;
const { ServiceAuthClient } = transport;
import { loadConfig } from "../src/config.ts";
import { authenticate } from "../src/auth.ts";
import { createSpace } from "../src/spaces.ts";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok = (m: string) => console.log(`  ${GREEN}✔${RESET} ${m}`);
const bad = (m: string) => console.log(`  ${RED}✘${RESET} ${m}`);
const info = (m: string) => console.log(`${YELLOW}${m}${RESET}`);

let failures = 0;
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) ok(label);
  else { bad(`${label}${detail ? ` — ${detail}` : ""}`); failures++; }
}

async function main() {
  const cfg = loadConfig();
  const { agent, xrpc } = await authenticate(cfg);
  info(`authenticated as ${agent.did}`);

  const adminDid = process.env.CANARY_ADMIN_DID || agent.did!;
  const cleanup = process.env.CANARY_CLEANUP !== "false";

  // 1. Create a disposable space (or reuse an existing one).
  let spaceId = process.env.CANARY_SPACE_ID;
  if (!spaceId) {
    info("creating canary space…");
    const { spaceId: sid } = await createSpace(xrpc, {
      name: `canary-${Date.now()}`,
      description: "dual-write canary (safe to delete)",
    });
    spaceId = sid;
  }
  info(`canary space: ${spaceId}`);
  await sleep(1200); // allow materialisation to land

  // 3. Write path sanity: the created space shows up in getSpaces (mono read).
  const spaces = await xrpc.query("space.roomy.space.getSpaces", {});
  const inList = (spaces as { spaces: { id: string }[] }).spaces.some((s) => s.id === spaceId);
  assert(inList, "getSpaces lists the new space (monolithic read path)");

  // 4. Post-create consistency: mono == global membership, per-space == mono.
  const report1 = await check(cfg, agent, spaceId);
  assert(report1.ok, "checkDualWrite ok after createSpace (membership in mono+global)", report1.error);
  logCounts(report1);

  // 5. Exercise per-space dual-write: createRoom, then createMessage (the
  //    message references the room, so create the room first and let it land).
  const roomId = newUlid();
  const msgId = newUlid();
  info("sending createRoom…");
  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [
      { id: roomId, $type: "space.roomy.room.createRoom.v0", kind: "space.roomy.channel", name: "canary" },
    ],
  });
  await sleep(1200);

  info("sending createMessage…");
  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [
      {
        id: msgId,
        $type: "space.roomy.message.createMessage.v0",
        room: roomId,
        body: { mimeType: "text/plain", data: { $bytes: Buffer.from("canary dual-write").toString("base64") } },
        extensions: {},
      },
    ],
  });
  await sleep(1500); // allow materialisation to land

  // 6. Post-write consistency: per-space comp_room/comp_content must match mono.
  const report2 = await check(cfg, agent, spaceId);
  assert(report2.ok, "checkDualWrite ok after createRoom+createMessage (per-space == mono)", report2.error);
  if (report2.verbose?.counts) {
    const c = report2.verbose.counts;
    assert(c.perSpace.comp_room === c.mono.comp_room, `comp_room mono==per-space (${c.mono.comp_room}==${c.perSpace.comp_room})`);
    assert(c.perSpace.comp_content === c.mono.comp_content, `comp_content mono==per-space (${c.mono.comp_content}==${c.perSpace.comp_content})`);
    assert(c.global.joinedSpace === c.mono.membership.joinedSpace, `membership mono==global (${c.mono.membership.joinedSpace}==${c.global.joinedSpace})`);
  }
  logCounts(report2);

  // 7. Optional cleanup: leave the space so it doesn't linger as a joined space.
  if (cleanup && !process.env.CANARY_SPACE_ID) {
    try {
      await xrpc.procedure("space.roomy.space.leaveSpace", { spaceId });
      info(`left canary space ${spaceId} (kept for includeLeft audit)`);
    } catch (e) {
      info(`cleanup leave skipped: ${(e as Error).message}`);
    }
  }

  if (failures === 0) {
    console.log(`${GREEN}${BOLD}CANARY PASS${RESET}: dual-write consistent for ${spaceId}`);
  } else {
    console.log(`${RED}${BOLD}CANARY FAIL${RESET}: ${failures} assertion(s) failed for ${spaceId}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

async function check(cfg: ReturnType<typeof loadConfig>, agent: Awaited<ReturnType<typeof authenticate>>["agent"], spaceId: string) {
  // checkDualWrite is an admin NSID with no SDK registry entry, so
  // DirectXrpcClient can't route it — call the transport directly.
  try {
    const sa = new ServiceAuthClient(agent);
    const tok = await sa.getToken(cfg.appserverDid, "space.roomy.admin.checkDualWrite");
    const res = await fetch(`${cfg.appserverUrl}/xrpc/space.roomy.admin.checkDualWrite?did=${encodeURIComponent(spaceId)}&verbose=1`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const body = await res.json();
    if (res.status !== 200) return { ok: false, verbose: undefined, error: `HTTP ${res.status}: ${JSON.stringify(body)}` };
    const s = (body as { spaces: CanarySpaceReport[] }).spaces[0];
    return { ok: s?.status === "ok", verbose: s };
  } catch (e) {
    return { ok: false, verbose: undefined, error: (e as Error).message ?? String(e) };
  }
}

interface CanarySpaceReport {
  streamDid: string;
  status: string;
  diffs: string[];
  counts?: {
    mono: { comp_room: number; comp_content: number; comp_space: number; comp_info: number; membership: { joinedSpace: number; leftSpace: number } };
    perSpace: { comp_room: number; comp_content: number; comp_space: number; comp_info: number; membership: { joinedSpace: number; leftSpace: number } };
    global: { joinedSpace: number; leftSpace: number };
  };
}

function logCounts(r: { ok: boolean; verbose?: CanarySpaceReport }) {
  const c = r.verbose?.counts;
  if (!c) return;
  console.log(`    mono:    rooms=${c.mono.comp_room} msgs=${c.mono.comp_content} joined=${c.mono.membership.joinedSpace}`);
  console.log(`    perSpace:rooms=${c.perSpace.comp_room} msgs=${c.perSpace.comp_content} joined=${c.perSpace.membership.joinedSpace}`);
  console.log(`    global:  joined=${c.global.joinedSpace} left=${c.global.leftSpace}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error(`${RED}${BOLD}canary error:${RESET}`, e); process.exit(1); });
