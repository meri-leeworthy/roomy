import { spawn } from "node:child_process";
import { sync, deserializeBody, blocksToPlaintext, extractMentionDids } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import type { AuthState } from "./auth.js";
import { sendMessage } from "./messages.js";
import { listRooms } from "./rooms.js";
import { listSpaces } from "./spaces.js";

const { SyncConnection } = sync;


export interface ListenOptions {
  /** Space to listen in. When omitted, listens to every space the agent has joined. */
  spaceId?: string;
  /** Specific room to listen in; defaults to all rooms in the space. */
  roomId?: string;
  /** Only respond when the agent is mentioned/tagged. Default true. */
  mentionOnly?: boolean;
  /** Working directory for the omp agent. */
  cwd?: string;
  /** omp model override (fuzzy match, e.g. "deepseek-v4-flash"). */
  model?: string;
  /** Extra context prepended to every prompt sent to the agent. */
  prefix?: string;
  /** Path to the omp binary. Defaults to `omp` on PATH. */
  ompBin?: string;
  /** How long to keep listening (ms). 0 = forever. */
  durationMs?: number;
  /** Also react to the agent's own messages (testing). Default false. */
  includeSelf?: boolean;
  /** Post the agent's thinking trace alongside its answer. Default true. */
  thinking?: boolean;
}

interface IncomingMessage {
  id: string;
  roomId: string;
  authorDid: string;
  authorName: string;
  content: string;
  mimeType?: string;
  timestamp: string;
}

/**
 * Listen to a Roomy space/room over the appserver WebSocket and route new
 * messages to the omp agent, posting the agent's reply back to the room.
 *
 * This is the MVP bridge: no streaming, no rich tool UI — just "mention the
 * agent in a room, get an answer back". It reuses the same XRPC auth as the
 * rest of the CLI and the SDK's `SyncConnection` for the live feed.
 */
export async function listen(
  auth: AuthState,
  opts: ListenOptions,
): Promise<void> {
  const { agent, xrpc } = auth;
  const identity = await resolveAgentIdentity(xrpc, agent);
  const mentionOnly = opts.mentionOnly ?? true;

  // When scoping to specific rooms, resolve them so we can filter incoming
  // mentions to just those rooms. (For the default all-spaces mentions
  // subscription this is empty — every mention is in scope.)
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
    logger: (m) => console.error(`[sync] ${m}`),
  });

  conn.onFrame((frame) => {
    const t = frame.header["t"];
    if (t === "#mention") {
      // Server-side mentions subscription: the appserver already filtered to
      // messages that mention the agent's DID. Route each `add` op to omp.
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
        void handleMessage(auth, opts, msg, body.roomId, body.spaceId, identity);
      }
      return;
    }
    if (t !== "#messageDiff") return;
    // Room subscription path (only used with --no-mention-only): respond to
    // every message in the scoped rooms.
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
      void handleMessage(auth, opts, msg, body.roomId, spaceId, identity);
    }
  });

  await conn.connect();
  if (mentionOnly) {
    // One subscription for all mentions across every space the agent is in.
    conn.subscribe({ kind: "mentions", id: identity.agentDid });
    console.error(`Listening for mentions of ${identity.agentName || identity.agentDid}`);
  } else {
    // --no-mention-only: subscribe to every room and respond to everything.
    const rooms = await resolveRooms(xrpc, opts.spaceId, opts.roomId);
    if (rooms.size === 0) {
      throw new Error("No rooms found to listen to");
    }
    for (const roomId of rooms.keys()) {
      conn.subscribe({ kind: "room", id: roomId });
      console.error(`Listening on room ${roomId}`);
    }
  }

  if (opts.durationMs && opts.durationMs > 0) {
    await new Promise((r) => setTimeout(r, opts.durationMs));
    conn.close();
  } else {
    // Keep the process alive until interrupted.
    await new Promise<never>((_, reject) => {
      process.on("SIGINT", () => {
        conn.close();
        reject(new Error("Interrupted"));
      });
      process.on("SIGTERM", () => {
        conn.close();
        reject(new Error("Terminated"));
      });
    });
  }
}

/**
 * Resolve the set of rooms to listen to, as a `roomId → spaceId` map.
 *
 * - `roomId` given: that single room (spaceId must also be given).
 * - `spaceId` given: every room in that space (via getMetadata, which is
 *   gated on membership — non-members get an empty sidebar).
 * - neither given: every room in every space the agent is a member of.
 */
async function resolveRooms(
  xrpc: AuthState["xrpc"],
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

interface AgentIdentity {
  agentDid: string;
  agentHandle: string;
  agentName: string;
}

async function handleMessage(
  auth: AuthState,
  opts: ListenOptions,
  msg: IncomingMessage,
  roomId: string,
  spaceId: string,
  identity: AgentIdentity,
): Promise<void> {
  const mentioned = isMentioned(msg, identity);
  const mentionOnly = opts.mentionOnly ?? true;
  if (mentionOnly && !mentioned) return;

  const prompt = buildPrompt(msg, roomId, identity, opts.prefix);
  console.error(
    `[agent] ${mentioned ? "mentioned" : "message"} from ${msg.authorName || msg.authorDid}: ${truncate(msg.content, 80)}`,
  );

  try {
    const reply = await runOmp(prompt, opts);
    if (!reply || !reply.answer.trim()) {
      console.error("[agent] empty reply — not posting");
      return;
    }
    const thinking = reply.thinking?.trim();
  const postThinking = (opts.thinking ?? true) && !!thinking;
  const blocks = buildReplyBlocks(reply.answer, postThinking ? thinking : undefined);
  const { messageId } = await sendMessage(
    auth.xrpc,
    spaceId,
    roomId,
    reply.answer,
    blocks.length > 0 ? { blocks } : {},
  );
    console.error(`[agent] replied ${messageId}${postThinking ? " (with thinking)" : ""}`);
  } catch (error) {
    console.error(
      `[agent] error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Resolve the agent's stable identity for mention matching.
 *
 * The DID is the authoritative, stable ID — it's what `#didMention` facets
 * carry, and it never changes (handles and display names do). We also fetch
 * the agent's Roomy profile so the plain-text fallback can match on the real
 * display name (e.g. "Redcurrant") rather than the handle or DID.
 */
async function resolveAgentIdentity(
  xrpc: AuthState["xrpc"],
  agent: AuthState["agent"],
): Promise<AgentIdentity> {
  const agentDid = agent.did ?? "";
  const agentHandle = agent.session?.handle ?? "";
  let agentName = agentDid;
  try {
    const profile = await xrpc.query("space.roomy.user.getProfile", {
      actor: agentDid,
    });
    if (profile?.displayName) agentName = profile.displayName;
  } catch {
    // Profile fetch is best-effort; fall back to the DID.
  }
  return { agentDid, agentHandle, agentName };
}

/**
 * Decide whether a message mentions the agent.
 *
 * The DID is the authoritative signal: a `#didMention` facet whose `did`
 * equals the agent's DID is a stable, unambiguous match (handles and display
 * names can change). Plain-text matching is a best-effort fallback for
 * messages that weren't authored with a rich mention — it matches the full
 * handle and the display name, but is inherently less reliable.
 */
export function isMentioned(msg: IncomingMessage, identity: AgentIdentity): boolean {
  const { agentDid, agentHandle, agentName } = identity;
  const mime = msg.mimeType ?? "";

  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) {
        const dids = extractMentionDids(blocks);
        if (dids.includes(agentDid)) return true;
      }
    } catch {
      // fall through to text matching
    }
  }

  const text = msg.content ?? "";
  const local = agentHandle.split("@").pop()?.split(".")[0] ?? "";
  const needles = [agentDid, agentHandle, local, agentName]
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const lower = text.toLowerCase();
  return needles.some((n) => n.length > 0 && lower.includes(n));
}

function buildPrompt(
  msg: IncomingMessage,
  roomId: string,
  identity: AgentIdentity,
  prefix?: string,
): string {
  const from = msg.authorName || msg.authorDid;
  const body = plaintext(msg);
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  parts.push(
    `[Message from ${from} in Roomy room ${roomId}]\n\n${body}`,
  );
  return parts.join("\n\n");
}

/** Extract plain text from a message regardless of mime type. */
function plaintext(msg: IncomingMessage): string {
  const mime = msg.mimeType ?? "";
  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) return blocksToPlaintext(blocks);
    } catch {
      // fall through
    }
  }
  return msg.content ?? "";
}

interface OmpReply {
  /** The model's thinking/reasoning trace, if the model produced one. */
  thinking?: string;
  /** The final answer text. */
  answer: string;
}

interface OmpJsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string; thinking?: string }[];
  };
}

/**
 * Run omp non-interactively (`omp -p`) in JSON mode and extract both the
 * final answer and the model's thinking trace.
 *
 * omp emits NDJSON events on stdout (one JSON object per line); the assistant
 * content is streamed as `text_delta`/`thinking_delta` updates and finalised in
 * `message_end`. We keep the last assistant `message_end` and read its content
 * blocks: `thinking` blocks carry the reasoning trace, `text` blocks the answer.
 */
function runOmp(prompt: string, opts: ListenOptions): Promise<OmpReply> {
  const bin = opts.ompBin ?? "omp";
  const args = ["-p", prompt, "--cwd", opts.cwd ?? process.cwd(), "--mode=json", "--print-thoughts"];
  if (opts.model) args.push("--model", opts.model);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`Failed to spawn ${bin}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`omp exited ${code}: ${err.slice(-500)}`));
        return;
      }
      const reply = parseOmpJson(out);
      if (!reply.answer.trim()) {
        // Nothing in the structured output; fall back to raw stdout (and stderr
        // tail) so the user isn't left with a silent failure.
        const fallback = (out.trim() || err.trim() || "").slice(-2000);
        resolve({ answer: fallback });
        return;
      }
      resolve(reply);
    });
  });
}

/** Parse omp's NDJSON output into { thinking, answer }. */
export function parseOmpJson(raw: string): OmpReply {
  const thinkingParts: string[] = [];
  const answerParts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let evt: OmpJsonEvent;
    try {
      evt = JSON.parse(line) as OmpJsonEvent;
    } catch {
      continue;
    }
    // Only the final assistant turn carries the full content; pick the last one
    // seen. Content blocks are `thinking` and `text`.
    if (evt.type === "message_end" && evt.message?.role === "assistant") {
      const content = evt.message.content ?? [];
      thinkingParts.length = 0;
      answerParts.length = 0;
      for (const block of content) {
        if (block.type === "thinking") {
          if (block.thinking) thinkingParts.push(block.thinking);
        } else if (block.type === "text") {
          if (block.text) answerParts.push(block.text);
        }
      }
    }
  }
  return {
    thinking: thinkingParts.length ? thinkingParts.join("\n\n") : undefined,
    answer: answerParts.join("\n"),
  };
}

/**
 * Build the rich-text blocks for the agent's reply: an optional thinking
 * blockquote followed by the answer as normal text. Always includes the answer
 * so the reply is never an empty document.
 */
export function buildReplyBlocks(answer: string, thinking?: string): Block[] {
  const blocks: Block[] = [];
  if (thinking) {
    blocks.push({
      $type: "space.roomy.richtext.blocks#blockquote",
      text: thinking,
    });
  }
  blocks.push({
    $type: "space.roomy.richtext.blocks#text",
    text: answer,
  });
  return blocks;
}

/** The appserver base64-encodes non-text content blobs (e.g. richtext JSON)
 * on the wire; decode back to bytes before parsing. */
function decodeContentBytes(content: string): Uint8Array {
  return Buffer.from(content, "base64");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
