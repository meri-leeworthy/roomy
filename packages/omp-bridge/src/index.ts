import { sync, transport } from "@roomy-space/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runOmp, buildPrompt } from "./omp.js";
import {
  sendReply, buildReplyBlocks, buildThinkingBlocks, isMentioned, plaintext, THINKING_MARKER,
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
  /** Stream the thinking trace to the room in message-sized chunks as it's
   *  produced (instead of bundling it with the final answer). Default true. */
  streamThinking?: boolean;
  /** Approx char threshold for each streamed thinking chunk. Default 2000. */
  thinkingChunkSize?: number;
  /** Path to a file whose contents are appended to omp's system prompt on every
   *  run (unified workflow context for each new session). */
  systemPromptFile?: string;
  /** How many recent messages in the room to load into the prompt when the
   *  agent is mentioned (conversation context). Default 20. 0 disables. */
  recent?: number;
  /** Give each room its own omp session so repeated mentions keep context. Default true. */
  continuity?: boolean;
  /** Where to persist room → omp session id mappings. Defaults to ~/.roomy/omp-sessions.json. */
  sessionFile?: string;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
}

export { runOmp, parseOmpJson, buildPrompt } from "./omp.js";
export { buildReplyBlocks, buildThinkingBlocks, buildMentionBlocks, isMentioned, plaintext } from "./messages.js";
export type { OmpReply, OmpOptions } from "./omp.js";

/**
 * Persist a per-room omp session id so repeated mentions in the same room
 * resume the same omp session (conversation continuity) across mentions and
 * across bridge restarts. Keyed by `${spaceId}:${roomId}`.
 */
class SessionStore {
  #data = new Map<string, string>();
  #file?: string;

  constructor(file?: string) {
    this.#file = file;
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) this.#data.set(k, v);
    } catch {
      // missing or corrupt file → start empty
    }
  }

  get(spaceId: string, roomId: string): string | undefined {
    return this.#data.get(`${spaceId}:${roomId}`);
  }

  set(spaceId: string, roomId: string, sessionId: string): void {
    this.#data.set(`${spaceId}:${roomId}`, sessionId);
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(
        this.#file,
        JSON.stringify(Object.fromEntries(this.#data), null, 2),
      );
    } catch {
      // persistence is best-effort
    }
  }
}

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
  const continuity = opts.continuity ?? true;
  const sessionFile = opts.sessionFile ?? path.join(os.homedir(), ".roomy", "omp-sessions.json");
  const sessions = continuity ? new SessionStore(sessionFile) : undefined;

  // Serialize omp runs per room so a burst of mentions can't race on the same
  // resumed omp session (each turn appends to the session file in order).
  const roomQueues = new Map<string, Promise<unknown>>();
  const enqueue = (roomId: string, task: () => Promise<unknown>) => {
    const prev = roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Log task failures instead of swallowing them: a rejected handleMessage
    // previously vanished silently, making the bridge quietly ignore mentions.
    roomQueues.set(roomId, next.catch((e) => log(`[task error] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)));
  };

  const scopedRooms = opts.spaceId || opts.roomId
    ? await resolveRooms(xrpc, opts.spaceId, opts.roomId)
    : new Map<string, string>();

  // Rooms we've subscribed to (a fallback to the server-side mentions topic so
  // mentions still get caught if the appserver doesn't emit #mention, and so a
  // room/thread created after startup is picked up on the next refresh).
  const subscribedRooms = new Set<string>();
  // Dedupe message ids across the #mention and #messageDiff paths (a mention
  // message arrives on both), pruning entries older than 10 minutes.
  const seen = new Map<string, number>();
  const processMessage = (msg: IncomingMessage, roomId: string, spaceId: string) => {
    if (!msg.id) return;
    const now = Date.now();
    for (const [k, v] of seen) if (now - v > 600_000) seen.delete(k);
    if (seen.has(msg.id)) return;
    seen.set(msg.id, now);
    if (msg.authorDid === identity.agentDid && !opts.includeSelf) return;
    enqueue(roomId, () => handleMessage(auth, opts, msg, roomId, spaceId, identity, sessions, log));
  };

  const ensureRoomSubs = () => {
    for (const roomId of scopedRooms.keys()) {
      if (subscribedRooms.has(roomId)) continue;
      conn.subscribe({ kind: "room", id: roomId });
      subscribedRooms.add(roomId);
      log(`Listening on room ${roomId}`);
    }
  };

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
    if (t !== "#mention" && t !== "#messageDiff") return;
    const body = frame.body as {
      spaceId?: string;
      roomId?: string;
      ops?: { op?: string; message?: IncomingMessage }[];
    };
    if (!body.roomId) return;
    if (t === "#messageDiff") {
      const sId = scopedRooms.get(body.roomId);
      if (!sId) return;
      for (const op of body.ops ?? []) {
        if (op.op !== "add" || !op.message) continue;
        processMessage(op.message, body.roomId, sId);
      }
      return;
    }
    // #mention: frame carries the space id directly.
    const sId = body.spaceId;
    if (!sId) return;
    if (opts.spaceId || opts.roomId) {
      // Scope mentions by the explicit space/room ids (not the rooms known at
      // startup), so a mention in a room/thread created after startup gets
      // through. The room-diff path already maps via scopedRooms.
      if (opts.roomId && body.roomId !== opts.roomId) return;
      if (opts.spaceId && sId !== opts.spaceId) return;
    }
    for (const op of body.ops ?? []) {
      if (op.op !== "add" || !op.message) continue;
      processMessage(op.message, body.roomId, sId);
    }
  });

  await conn.connect();

  // The server-side mentions topic is the primary, authoritative signal.
  conn.subscribe({ kind: "mentions", id: identity.agentDid });
  log(`Listening for mentions of ${identity.agentName || identity.agentDid}`);

  // Also subscribe to the rooms we can see, so mention detection still works
  // via isMentioned (facet + plain-text fallback) if the appserver doesn't emit
  // #mention frames, and so new rooms/threads are covered by periodic refresh.
  ensureRoomSubs();
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await resolveRooms(xrpc, opts.spaceId, opts.roomId);
      for (const [roomId, spaceId] of fresh) scopedRooms.set(roomId, spaceId);
      ensureRoomSubs();
    } catch (error) {
      log(`room refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60_000);


  const shutdown = () => {
    clearInterval(refreshTimer);
    conn.close();
  };
  if (opts.durationMs && opts.durationMs > 0) {
    await new Promise((r) => setTimeout(r, opts.durationMs));
    shutdown();
  } else {
    await new Promise<never>((_, reject) => {
      const onSignal = (sig: string) => {
        shutdown();
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

/**
 * Fetch recent messages in a room, build a compact conversation-context string
 * (oldest-first, excluding the agent's own replies and the triggering message),
 * and surface the thread parent of the triggering message so the reply can be
 * threaded into the same conversation.
 */
async function fetchRecentContext(
  xrpc: DirectXrpcClient,
  roomId: string,
  agentDid: string,
  msgId: string,
  limit: number,
): Promise<{ context: string; parent?: string }> {
  if (limit <= 0) return { context: "" };
  try {
    const res = await xrpc.query("space.roomy.room.getMessages", {
      roomId,
      limit: String(limit),
    });
    const lines: string[] = [];
    let parent: string | undefined;
    for (const m of (res.messages as any[]) ?? []) {
      if (m.id === msgId) {
        parent = m.replyTo ?? parent;
        continue;
      }
      if (m.authorDid === agentDid) continue; // skip our own replies
      const from = m.authorName ?? m.authorDid ?? "?";
      const content = plaintext({ content: m.content ?? "", mimeType: m.mimeType ?? "text/markdown" } as IncomingMessage);
      if (!content) continue;
      // Skip thinking-trace messages (marked with 💭) — high noise, low signal;
      // they pollute the context and aren't part of the real conversation.
      if (content.startsWith(THINKING_MARKER)) continue;
      lines.push(`[${from}]: ${content}`);
    }
    const context = lines.length
      ? `Recent conversation in this room (oldest first):\n${lines.reverse().join("\n")}`
      : "";
    return { context, parent };
  } catch {
    return { context: "", parent: undefined };
  }
}

async function handleMessage(
  auth: BridgeAuth,
  opts: BridgeOptions,
  msg: IncomingMessage,
  roomId: string,
  spaceId: string,
  identity: AgentIdentity,
  sessions: SessionStore | undefined,
  log: (m: string) => void,
): Promise<void> {
  const mentioned = isMentioned(msg, identity);
  const mentionOnly = opts.mentionOnly ?? true;
  if (mentionOnly && !mentioned) return;

  const recent = opts.recent ?? 20;
  const ctx = await fetchRecentContext(auth.xrpc, roomId, identity.agentDid, msg.id, recent);
  const prompt = buildPrompt(msg, roomId, identity, opts.prefix, ctx.context);
  const parent = ctx.parent ?? msg.id;
  const resume = sessions?.get(spaceId, roomId);
  if (resume) log(`continuing omp session ${resume}`);
  log(`${mentioned ? "mentioned" : "message"} from ${msg.authorName || msg.authorDid}: ${truncate(msg.content, 80)}`);

  try {
    const streamThinking = opts.streamThinking ?? true;
    // Serialize streamed thinking-chunk posts so they land in order, and so the
    // final answer is posted only after every chunk has been sent.
    let thinkingChain: Promise<unknown> = Promise.resolve();
    let streamedThinking = false;
    const reply = await runOmp(prompt, { ...opts, resume }, {
      onThinking: (chunk) => {
        streamedThinking = true;
        thinkingChain = thinkingChain.then(() =>
          sendReply(auth.xrpc, spaceId, roomId, chunk, buildThinkingBlocks(chunk), parent),
        );
      },
    });
    if (reply.sessionId) sessions?.set(spaceId, roomId, reply.sessionId);
    if (!reply || !reply.answer.trim()) {
      log("empty reply — not posting");
      return;
    }
    await thinkingChain;
    if (streamThinking && streamedThinking) {
      // Thinking was already streamed to the room as messages; post the answer.
      const { messageId } = await sendReply(auth.xrpc, spaceId, roomId, reply.answer, undefined, parent);
      log(`replied ${messageId} (answer; thinking streamed)`);
    } else {
      const thinking = reply.thinking?.trim();
      const postThinking = (opts.thinking ?? true) && !!thinking;
      const blocks = buildReplyBlocks(reply.answer, postThinking ? thinking : undefined);
      const { messageId } = await sendReply(
        auth.xrpc,
        spaceId,
        roomId,
        reply.answer,
        blocks.length > 0 ? blocks : undefined,
        parent,
      );
      log(`replied ${messageId}${postThinking ? " (with thinking)" : ""}`);
    }
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
