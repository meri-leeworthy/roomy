import { sync, transport } from "@roomy-space/sdk";
import { runOmp, buildPrompt } from "./omp.js";
import {
  sendReply, buildReplyBlocks, isMentioned, plaintext,
  type IncomingMessage, type AgentIdentity,
} from "./messages.js";

const { SyncConnection } = sync;
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/** Authenticated context the bridge needs to talk to the appserver.
 *  Structurally compatible with the CLI's AuthState ({ agent, xrpc }). */
export interface BridgeAuth {
  agent: { did?: string; session?: { handle?: string } };
  xrpc: DirectXrpcClient;
}

export interface BridgeOptions {
  /** Space to listen in. When omitted, listens to every space the agent joined. */
  spaceId?: string;
  /** Specific room; defaults to all rooms in the space. */
  roomId?: string;
  /** Only respond when the agent is mentioned/tagged. Default true. */
  mentionOnly?: boolean;
  /** Working directory for the omp agent. */
  cwd?: string;
  /** omp model override (fuzzy match). */
  model?: string;
  /** Extra context prepended to every prompt. */
  prefix?: string;
  /** Path to the omp binary. Defaults to `omp` on PATH. */
  ompBin?: string;
  /** How long to keep listening (ms). 0 = forever. */
  durationMs?: number;
  /** Also react to the agent's own messages (testing). Default false. */
  includeSelf?: boolean;
  /** Post the agent's thinking trace alongside its answer. Default true. */
  thinking?: boolean;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
}

export { runOmp, parseOmpJson, buildPrompt } from "./omp.js";
export { buildReplyBlocks, buildMentionBlocks, isMentioned, plaintext } from "./messages.js";
export type { OmpReply, OmpOptions } from "./omp.js";

/**
 * Listen to Roomy over the appserver WebSocket and route messages that mention
 * the agent to the omp coding agent, posting the reply back to the room.
 *
 * Default: subscribes to the server-side `mentions:<did>` topic (one
 * subscription, all spaces). With `--no-mention-only` it falls back to
 * per-room subscriptions and responds to every message.
 */
export async function listen(auth: BridgeAuth, opts: BridgeOptions): Promise<void> {
  const { agent, xrpc } = auth;
  const log = opts.log ?? ((m: string) => console.error(`[bridge] ${m}`));
  const identity = await resolveAgentIdentity(xrpc, agent);
  const mentionOnly = opts.mentionOnly ?? true;

  const scopedRooms = opts.spaceId || opts.roomId
    ? await resolveRooms(xrpc, opts.spaceId, opts.roomId)
    : new Map<string, string>();

  const wsOrigin = xrpc.appserverUrl.replace(/^http/, "ws");
  const wsUrl = `${wsOrigin.replace(/\/+$/, "")}/xrpc/space.roomy.sync.subscribe`;

  const conn = new SyncConnection({
    wsUrl,
    fetchTicket: async () => {
      const res = await xrpc.procedure("space.roomy.auth.getConnectionTicket", {});
      return res.ticket;
    },
    logger: (m) => log(m),
  });

  conn.onFrame((frame) => {
    const t = frame.header["t"];
    if (t === "#mention") {
      const body = frame.body as {
        spaceId?: string;
        roomId?: string;
        ops?: { op?: string; message?: IncomingMessage }[];
      };
      if (!body.roomId || !body.spaceId) return;
      if (scopedRooms.size > 0 && !scopedRooms.has(body.roomId)) return;
      for (const op of body.ops ?? []) {
        if (op.op !== "add" || !op.message) continue;
        const msg = op.message;
        if (msg.authorDid === identity.agentDid && !opts.includeSelf) continue;
        void handleMessage(auth, opts, msg, body.roomId, body.spaceId, identity, log);
      }
      return;
    }
    if (t !== "#messageDiff") return;
    const body = frame.body as {
      roomId?: string;
      ops?: { op?: string; message?: IncomingMessage }[];
    };
    if (!body.roomId) return;
    const spaceId = scopedRooms.get(body.roomId);
    if (!spaceId) return;
    for (const op of body.ops ?? []) {
      if (op.op !== "add" || !op.message) continue;
      const msg = op.message;
      if (msg.authorDid === identity.agentDid && !opts.includeSelf) continue;
      void handleMessage(auth, opts, msg, body.roomId, spaceId, identity, log);
    }
  });

  await conn.connect();
  if (mentionOnly) {
    conn.subscribe({ kind: "mentions", id: identity.agentDid });
    log(`Listening for mentions of ${identity.agentName || identity.agentDid}`);
  } else {
    const rooms = await resolveRooms(xrpc, opts.spaceId, opts.roomId);
    if (rooms.size === 0) throw new Error("No rooms found to listen to");
    for (const roomId of rooms.keys()) {
      conn.subscribe({ kind: "room", id: roomId });
      log(`Listening on room ${roomId}`);
    }
  }

  if (opts.durationMs && opts.durationMs > 0) {
    await new Promise((r) => setTimeout(r, opts.durationMs));
    conn.close();
  } else {
    await new Promise<never>((_, reject) => {
      const onSignal = (sig: string) => {
        conn.close();
        reject(new Error(sig));
      };
      process.on("SIGINT", () => onSignal("Interrupted"));
      process.on("SIGTERM", () => onSignal("Terminated"));
    });
  }
}

async function resolveAgentIdentity(
  xrpc: DirectXrpcClient,
  agent: BridgeAuth["agent"],
): Promise<AgentIdentity> {
  const agentDid = agent.did ?? "";
  const agentHandle = agent.session?.handle ?? "";
  let agentName = agentDid;
  try {
    const profile = await xrpc.query("space.roomy.user.getProfile", { actor: agentDid });
    if (profile?.displayName) agentName = profile.displayName;
  } catch {
    // best-effort
  }
  return { agentDid, agentHandle, agentName };
}

async function handleMessage(
  auth: BridgeAuth,
  opts: BridgeOptions,
  msg: IncomingMessage,
  roomId: string,
  spaceId: string,
  identity: AgentIdentity,
  log: (m: string) => void,
): Promise<void> {
  const mentioned = isMentioned(msg, identity);
  const mentionOnly = opts.mentionOnly ?? true;
  if (mentionOnly && !mentioned) return;

  const prompt = buildPrompt(msg, roomId, identity, opts.prefix);
  log(`${mentioned ? "mentioned" : "message"} from ${msg.authorName || msg.authorDid}: ${truncate(msg.content, 80)}`);

  try {
    const reply = await runOmp(prompt, opts);
    if (!reply || !reply.answer.trim()) {
      log("empty reply — not posting");
      return;
    }
    const thinking = reply.thinking?.trim();
    const postThinking = (opts.thinking ?? true) && !!thinking;
    const blocks = buildReplyBlocks(reply.answer, postThinking ? thinking : undefined);
    const { messageId } = await sendReply(
      auth.xrpc,
      spaceId,
      roomId,
      reply.answer,
      blocks.length > 0 ? blocks : undefined,
    );
    log(`replied ${messageId}${postThinking ? " (with thinking)" : ""}`);
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveRooms(
  xrpc: DirectXrpcClient,
  spaceId?: string,
  roomId?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (roomId) {
    if (!spaceId) throw new Error("--room requires --space");
    out.set(roomId, spaceId);
    return out;
  }

  const spaceIds = spaceId
    ? [spaceId]
    : (await listSpaces(xrpc)).filter((s) => s.isMember).map((s) => s.id);

  for (const sid of spaceIds) {
    const { categories, orphans } = await listRooms(xrpc, sid);
    for (const r of [...categories.flatMap((c) => c.channels), ...orphans]) {
      out.set(r.id, sid);
    }
  }
  return out;
}

async function listSpaces(xrpc: DirectXrpcClient): Promise<{ id: string; isMember: boolean }[]> {
  const result = await xrpc.query("space.roomy.space.getSpaces", {});
  return result.spaces.map((s) => ({ id: s.id, isMember: s.isMember }));
}

async function listRooms(
  xrpc: DirectXrpcClient,
  spaceId: string,
): Promise<{ categories: { channels: { id: string }[] }[]; orphans: { id: string }[] }> {
  const meta = await xrpc.query("space.roomy.space.getMetadata", { spaceId });
  return {
    categories: meta.sidebar.categories.map((cat) => ({
      channels: cat.channels.map((ch) => ({ id: ch.id })),
    })),
    orphans: meta.sidebar.orphans.map((ch) => ({ id: ch.id })),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
