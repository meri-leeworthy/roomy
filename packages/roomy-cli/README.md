# @roomy/cli

Command-line interface for Roomy, enabling remote-controllable agents via Claude Code integration.

## Installation

```bash
pnpm install
```

## Usage

### Environment Variables

Required:
- `ROOMY_SPACE_DID` - The DID of the space to create rooms in

Optional (first run):
- `ATPROTO_IDENTIFIER` - Your ATProto handle or DID
- `ATPROTO_APP_PASSWORD` - Your ATProto app password

Optional (with defaults):
- `ROOMY_SESSION_FILE` - Path to ATProto session cache (default: `~/.roomy/session.json`)
- `ROOMY_ROOM_MAP_FILE` - Path to session ID → room ULID mapping (default: `~/.roomy/rooms.json`)
- `LEAF_URL` - Leaf server URL (default: `http://localhost:3000`)
- `LEAF_DID` - Leaf server DID (default: `did:web:localhost`)

### Send Command

Send a message from stdin to a room associated with a Claude Code session:

```bash
echo "Hello, Roomy!" | roomy-cli send --claude-session <session-id>
```

The first time you run this, it will:
1. Authenticate using your ATProto credentials
2. Create a new room named `claude-session-<id>`
3. Send your message to that room

Subsequent runs with the same session ID will send to the same room.

### Example with Claude Code

```bash
export ROOMY_SPACE_DID="did:plc:your-space-did"
export ATPROTO_IDENTIFIER="your-handle.bsky.social"
export ATPROTO_APP_PASSWORD="your-app-password"

# Log a Claude Code session
echo "Working on feature X" | roomy-cli send --claude-session my-session-123
```

## Development

```bash
# Watch mode
pnpm dev

# Build
pnpm build

# Run directly
pnpm start send --claude-session test-session
```

## Architecture

The CLI is structured into several modules:

- **cli.ts** - Main entry point, parses arguments with commander
- **auth.ts** - ATProto authentication with session caching
- **rooms.ts** - Room creation and session ID → room ULID mapping
- **send.ts** - Message posting via Leaf client
- **config.ts** - Environment variable parsing and file I/O helpers
- **types.ts** - TypeScript interfaces for SessionData, RoomMap, and Config

See the full design document at `docs/plans/.llm.2026-02-02-roomy-cli-design.md`.
