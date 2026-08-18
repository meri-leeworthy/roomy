# Roomy CLI

CLI tool for Roomy — space management and agent testing via the appserver XRPC interface.

## Setup

```bash
pnpm install --filter @roomy/cli
pnpm --filter @roomy/cli build
```

## Configuration

Set these environment variables (or copy `.env.example` to `.env` and source it):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ATPROTO_IDENTIFIER` | yes | — | Bluesky handle or DID |
| `ATPROTO_APP_PASSWORD` | yes | — | App password (generate at bsky.app/settings/app-passwords) |
| `ATPROTO_PDS` | no | *(auto-resolved from DID doc)* | PDS service endpoint to log in against. Defaults to the account's `AtprotoPersonalDataServer` from its PLC DID document, falling back to `https://bsky.social`. Override when auto-detection fails. |
| `APPSERVER_URL` | no | `http://localhost:8080` | Roomy appserver URL |
| `APPSERVER_DID` | no | `did:web:api.roomy.space` | Appserver DID |

## Usage

```bash
# Via pnpm
pnpm --filter @roomy/cli start <command>

# Via tsx directly
npx tsx packages/cli/src/cli.ts <command>

# Via the built binary
./packages/cli/bin/roomy-cli.ts <command>
```

## Commands

### `spaces`

List all spaces the authenticated user is a member of.

```bash
roomy-cli spaces
```

### `create-space`

Create a new Roomy space.

```bash
roomy-cli create-space --name "My Space" [--description "A description"]
```

### `join`

Join a space (public join, or with an invite token for private spaces).

```bash
roomy-cli join --space <space-did>
roomy-cli join --space <space-did> --invite-token <token>
```

### `profile`

Set (or update) the authenticated user's Roomy profile.

```bash
roomy-cli profile --display-name "Little Fox" [--description "..."] [--pronouns "she/her"] [--website https://...]
```

### `rooms`

List channels (rooms) in a space, grouped by sidebar category.

```bash
roomy-cli rooms --space <space-did>
```

### `send`

Send a message to a room. Accepts text inline or piped via stdin. If `--room`
is omitted, the message goes to the space's **lobby** room.

```bash
roomy-cli send --space <space-did> --room <room-id> --text "Hello!"
roomy-cli send --space <space-did> --text "Hello!"          # → lobby
roomy-cli send --space <space-did> --room <room-id>          # text via stdin
```

Send a **Roomy-native rich mention** (a `#didMention` facet, rendered as a
mention chip — not plain `@handle` text):

```bash
roomy-cli send --space <space-did> --room <room-id> \
  --mention <did> --mention-label <handle> --text "your message"
```

### `read`

Read recent messages from a room. If `--room` is omitted, reads the space's
**lobby** room. System events (e.g. "joined the space") show a `—` timestamp.

```bash
roomy-cli read --room <room-id> [--limit 20]
roomy-cli read --space <space-did> [--limit 20]   # → lobby
```


### `listen`

Listen to a space/room over the appserver WebSocket and route **mentioned**
messages to the omp agent, posting the agent's reply back to the room. This is
the MVP bridge for using Roomy as a web client for omp — no streaming, no tool
UI, just "mention the agent, get an answer back".

By default the bridge subscribes to the appserver's **server-side mentions
subscription** (`mentions:<agentDid>`), so it receives every message that
mentions the agent across all spaces it has joined — one subscription, no
per-room bookkeeping.

```bash
roomy-cli listen [--space <space-did>] [--room <room-id>] [--cwd <dir>] [--model <model>]
```

Options:

- `--space <id>` — scope to one space; **omitted, listens to every space the
  agent has joined**.
- `--room <id>` — scope to one room.
- `--no-mention-only` — respond to every message, not just mentions (falls back
  to per-room subscriptions; useful for a dedicated agent-only room).
- `--cwd <dir>` — working directory for the omp agent.
- `--model <model>` — omp model override (fuzzy match).
- `--prefix <text>` — extra context prepended to every prompt.
- `--omp-bin <path>` — path to the omp binary (default: `omp` on PATH).
- `--duration <ms>` — stop after this many ms (0 = run forever).
- `--include-self` — also react to the agent's own messages (testing).
- `--no-thinking` — post only the agent's answer, not its thinking trace.

Mention detection is **server-side and DID-authoritative**: the appserver emits
a `#mention` frame for messages whose `#didMention` facets (or mentions
extension) include the agent's DID. The agent ignores its own messages to avoid
self-trigger loops.

The agent's reply is posted as a rich message: the model's **thinking trace**
(as a blockquote, when the model produced one) followed by the final answer.
Use `--no-thinking` to suppress the thinking trace.

> The bridge itself now lives in the standalone **`@roomy/omp-bridge`** package
> (`packages/omp-bridge`); `listen` is a thin wrapper that wires it up with CLI
> auth and flags. See that package's README for the bridge internals.

See `docs/omp-bridge.md` for the full research and design notes.

## Agent Testing

The CLI is designed for agent-driven workflows. Example with Claude Code:

```bash
# Create a space for agent testing
roomy-cli create-space --name "Agent Test"

# List spaces to get the space DID
roomy-cli spaces

# List rooms to find the lobby channel ID
roomy-cli rooms --space <space-did>

# Send a message
roomy-cli send --space <space-did> --room <room-id> --text "Agent message"

# Read responses
roomy-cli read --room <room-id> --limit 10
```
