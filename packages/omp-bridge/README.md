# @roomy/omp-bridge

Roomy → omp agent bridge. Listens to the appserver for messages that mention
the agent and answers them via the [omp](https://omp.app) coding agent, posting
the reply back to the room.

The bridge was extracted out of `@roomy/cli` into its own package so it can be
run and deployed independently of the CLI (and, eventually, as a standalone
service in its own repo).

## How it works

```
Roomy room ──WS──▶ appserver (mention detection) ──#mention──▶ bridge ──▶ omp -p ──▶ reply
     ▲                                                                              │
     └────────────────────────────── sendReply(reply) ◀────────────────────────────┘
```

- Subscribes to the appserver's **server-side mentions subscription**
  (`mentions:<did>`), so it receives every message that mentions the agent
  across all spaces it has joined — one subscription, no per-room bookkeeping.
- Runs `omp -p --mode=json --print-thoughts` and posts the model's **thinking
  trace** to the room in **message-sized chunks as it streams** (each chunk a
  blockquote message), then posts the final answer as its own message. Set
  `streamThinking: false` to bundle the thinking with the answer instead, or
  `thinkingChunkSize` to tune the chunk threshold (default 2000 chars).
- Mention matching is DID-authoritative; self-mentions are excluded.
- **Session continuity (default on):** each room keeps its own omp session. The
  first mention in a room starts a fresh session; later mentions `--resume` that
  session so the agent remembers the conversation across mentions (and across
  bridge restarts). The room → session map is persisted to `~/.roomy/omp-sessions.json`
  (override with `sessionFile`; disable with `continuity: false`). Runs in the
  same room are serialized so concurrent mentions can't race on a resumed session.

## Usage

```ts
import { listen } from "@roomy/omp-bridge";

await listen(auth, {
  cwd: "/path/to/workspace",
  // spaceId / roomId to scope; omitted = all joined spaces
  // model: "deepseek-v4-flash", prefix: "...", ompBin: "omp"
  // continuity: true,  // per-room omp session (conversation continuity)
  // sessionFile: "~/.roomy/omp-sessions.json",
  // streamThinking: true,  // stream thinking chunks as messages (default)
  // thinkingChunkSize: 2000,
  // systemPromptFile: "~/.omp/workflow-context.md",  // appended to omp's system prompt every run
});
```

`auth` is structurally compatible with the CLI's `AuthState` (`{ agent, xrpc }`):
an authenticated ATProto agent and a `DirectXrpcClient` pointed at the appserver.

## API

- `listen(auth, options)` — run the bridge (blocks until interrupted)
- `runOmp(prompt, opts)` / `parseOmpJson(raw)` — run omp and parse its NDJSON
- `buildReplyBlocks(answer, thinking?)` — build the reply's richtext blocks
- `sendReply(xrpc, spaceId, roomId, text, blocks?)` — post a reply

See `packages/cli/src/cli.ts` for the `roomy-cli listen` command that wires this
up with CLI auth/flags.
