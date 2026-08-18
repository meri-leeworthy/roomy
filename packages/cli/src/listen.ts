import { spawn } from "node:child_process";
import { sync, deserializeBody, blocksToPlaintext, extractMentionDids } from "@roomy-space/sdk";
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

  // Resolve the set of rooms to subscribe to (roomId → spaceId).
  const rooms = await resolveRooms(xrpc, opts.spaceId, opts.roomId);
  if (rooms.size === 0) {
    throw new Error(
      opts.spaceId
        ? `No rooms found in space ${opts.spaceId}`
        : "No rooms found in any space the agent has joined",
    );
  }

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
    if (t !== "#messageDiff") return;
    const body = frame.body as {
      roomId?: string;
      ops?: { op?: string; message?: IncomingMessage }[];
    };
    if (!body.roomId) return;
    const spaceId = rooms.get(body.roomId);
    if (!spaceId) return; // not one of the rooms we're listening to
    for (const op of body.ops ?? []) {
      if (op.op !== "add" || !op.message) continue;
      const msg = op.message;
      // Ignore our own messages (the agent replying to itself).
      if (msg.authorDid === identity.agentDid && !opts.includeSelf) continue;
      void handleMessage(auth, opts, msg, body.roomId, spaceId, identity);
    }
  });

  await conn.connect();
  for (const roomId of rooms.keys()) {
    conn.subscribe({ kind: "room", id: roomId });
    console.error(`Listening on room ${roomId}`);
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
    if (!reply) {
      console.error("[agent] empty reply — not posting");
      return;
    }
    const { messageId } = await sendMessage(
      auth.xrpc,
      spaceId,
      roomId,
      reply,
    );
    console.error(`[agent] replied ${messageId}`);
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

/**
 * Run omp non-interactively (`omp -p`) and return its stdout text.
 * MVP uses the single-shot print mode; a future version can drive
 * `omp --mode rpc-ui` for streaming and tool UI.
 */
function runOmp(prompt: string, opts: ListenOptions): Promise<string> {
  const bin = opts.ompBin ?? "omp";
  const args = ["-p", prompt, "--cwd", opts.cwd ?? process.cwd()];
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
      resolve(out.trim());
    });
  });
}

/** The appserver base64-encodes non-text content blobs (e.g. richtext JSON)
 * on the wire; decode back to bytes before parsing. */
function decodeContentBytes(content: string): Uint8Array {
  return Buffer.from(content, "base64");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
