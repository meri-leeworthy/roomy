# App Scripts

Development scripts for the roomy.chat app package.

## seed-test-space.ts

Creates a test Roomy space with ~100,000 events for load testing and development.

### How it works

The script connects directly to the Leaf server using the test auth token and sends Roomy events (CBOR-encoded). It uses the `authorOverride` extension to create events that appear from different fake users.

**Note:** The Leaf server must already be running with a stream created. This script only injects events into existing streams.

### Prerequisites

1. Start the Leaf server with an unsafe auth token:
```bash
# In the leaf repo
leaf-server server \
  --unsafe-auth-token test123 \
  --listen-address 0.0.0.0:5530 \
  --did did:web:localhost
```

2. Create a stream (e.g., through the Roomy app or using the Leaf CLI)

### Usage

```bash
# From packages/app directory
SPACE_STREAM_DID=did:example:stream123 pnpm seed:test-space

# Or from root using turbo
SPACE_STREAM_DID=did:example:stream123 pnpm --filter roomy.chat seed:test-space

# With custom event count
EVENT_COUNT=50000 SPACE_STREAM_DID=did:example:stream123 pnpm seed:test-space
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LEAF_URL` | `http://localhost:5530` | Leaf server URL |
| `LEAF_TEST_TOKEN` | `test123` | Token matching Leaf's `--unsafe-auth-token` |
| `SPACE_STREAM_DID` | *required* | Stream DID to inject events into |
| `EVENT_COUNT` | `100000` | Total number of events to create |
| `ROOM_COUNT` | `100` | Number of rooms to create |
| `USER_COUNT` | `50` | Number of fake users to simulate |

### What gets created

1. **User profiles** - Profile events for each fake user
2. **Rooms** - 100 rooms with different names (general, random, dev, etc.)
3. **Messages** - ~1000 messages per room with varied content
4. **Replies** - ~20% of messages are replies to other messages
5. **Reactions** - ~50 reactions per room with various emojis

All events use the `authorOverride` extension to make them appear from different fake DIDs.

### Safety

**⚠️ NEVER use `--unsafe-auth-token` in production.** This bypass is only for local development.

### Example output

```
============================================================
Roomy Test Space Seeder
============================================================
Leaf URL: http://localhost:5530
Test Token: test123
Stream DID: did:example:stream123
Target events: 100,000
Rooms to create: 100
Fake users: 50
============================================================
[0.5s | 0 events | 0 ev/s] Connected to Leaf server
[0.6s | 0 events | 0 ev/s] Authenticated as test user
[1.2s | 50 events | 50 ev/s] Phase 1: Creating user profiles...
[2.1s | 150 events | 75 ev/s] Phase 2: Creating rooms...
...
============================================================
Seeding complete!
============================================================
Total events created: 100,000
Rooms created: 100
Time elapsed: 45.2s
Average rate: 2212.4 events/second
============================================================
```
