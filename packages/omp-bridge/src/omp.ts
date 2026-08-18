import { spawn } from "node:child_process";
import { plaintext, type AgentIdentity, type IncomingMessage } from "./messages.js";

/** Result of running omp: the model's thinking trace and final answer. */
export interface OmpReply {
  thinking?: string;
  answer: string;
}

export interface OmpOptions {
  /** Working directory for the omp agent. */
  cwd?: string;
  /** omp model override (fuzzy match). */
  model?: string;
  /** Extra context prepended to every prompt. */
  prefix?: string;
  /** Path to the omp binary. Defaults to `omp` on PATH. */
  ompBin?: string;
}

/**
 * Run omp non-interactively (`omp -p`) in JSON mode and extract both the final
 * answer and the model's thinking trace.
 *
 * omp emits NDJSON events on stdout (one JSON object per line); the assistant
 * content is streamed as `text_delta`/`thinking_delta` updates and finalised in
 * `message_end`. We keep the last assistant `message_end` and read its content
 * blocks: `thinking` blocks carry the reasoning trace, `text` blocks the answer.
 */
export function runOmp(prompt: string, opts: OmpOptions): Promise<OmpReply> {
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

interface OmpJsonEvent {
  type?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string; thinking?: string }[];
  };
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

/** Build the prompt sent to omp from an incoming message. */
export function buildPrompt(
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
