# LiveKit deployment runbook

How to get from no SFU to two browsers in a call. Voice chat's server
(`packages/appserver/src/voice/`) and client (`packages/app-lite/src/lib/voice/`)
code is in place; this document is the deployment around it.

Scope: one LiveKit server, the appserver environment that points at it, the
webhook back to the appserver, and the two gates that are not environment
variables. Out of scope: scaling the SFU beyond one node, recording/egress, and
the Rust worker's voice reads beyond the difference noted in §6.

Every claim about this repository cites `file:line`; every claim about an
external system cites the vendor's own page. Where something cannot be verified
from either, it is marked **unverified** rather than asserted.

## Contents

1. [Prerequisites — the four gates](#1-prerequisites--the-four-gates)
2. [Appserver variables](#2-appserver-variables)
3. [LiveKit server configuration](#3-livekit-server-configuration)
4. [Ports and TLS](#4-ports-and-tls)
5. [Platform constraints](#5-platform-constraints)
6. [Verification chain](#6-verification-chain)
7. [Rollout](#7-rollout)

---

## 1. Prerequisites — the four gates

Voice works only when all four hold. Three are conventional; the fourth (OAuth
scopes) is the one that costs an afternoon, because the appserver answers
correctly and the call still fails.

| # | Gate | Satisfied by | Symptom when missing |
|---|------|--------------|----------------------|
| a | LiveKit reachable and named by the appserver | `LIVEKIT_URL` + key pair in the appserver environment (§2) | `getToken` returns all null; no call UI anywhere |
| b | LiveKit posts webhooks to the appserver | `webhook:` block on the LiveKit server (§3) | Calls work, but join/leave/end facts arrive only from client intent and the 30 s reconciler |
| c | The `voice-chat` feature flag is granted | `space.roomy.admin.setFlag` (§7) | Voice rooms render as ordinary rooms; the client issues no voice RPC |
| d | The session's OAuth grant contains the five voice RPC scopes | Scope registration + a login that requests them (§1.4) | Every voice RPC is refused: "Voice permission missing" |

Gate (c) is a registered flag that defaults off:

- `packages/appserver/src/featureFlags.ts:57-61` registers `voice-chat`
  ("Voice rooms: the sidebar's call list and the room's call panel").
- All flags default to false (`packages/appserver/src/featureFlags.ts:8-9`).
- The client reads it in two places and gates every voice request on it:
  `packages/app-lite/src/routes/[space]/[room]/+page.svelte:181-189` (room
  surface) and `packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:81-88`
  (the call list, whose query is `enabled: () => voiceChatEnabled`,
  `SpaceSidebar.svelte:94-96`).

### 1.4 Gate (d): the voice RPC scopes

This gate has two independently deployed halves, and the second half is not in
this repository (`packages/app-lite/src/lib/scopes.ts:12-44`).

**Why the scopes are needed at all.** The browser does not call the appserver
through the PDS. `DirectXrpcClient` mints a per-RPC service-auth JWT with
`com.atproto.server.getServiceAuth` and sends it as a bearer token
(`packages/sdk/src/transport/direct-xrpc.ts:1-27`); `ServiceAuthClient` is the
mint, keyed by `aud:lxm` and capped at a 300 s requested lifetime
(`packages/sdk/src/transport/service-auth.ts:4-10`, `:89-126`). Atproto defines
an `rpc:` permission as "The ability to make authenticated API requests to
remote services. This includes both requesting service auth tokens (JWTs) using
the `com.atproto.server.getServiceAuth` endpoint on the PDS, and requests
proxied via the PDS", parameterised by the lexicon method (`lxm`) and the
audience (`aud`) — <https://atproto.com/specs/permission>.

So a session must hold `rpc:space.roomy.voice.<nsid>?aud=<appserver did>` for
the PDS to mint a service-auth token for that lxm. The permission to *call*
`getServiceAuth` is already in `base`
(`packages/app-lite/src/lib/scopes.ts:244` and `:250`); what a grant lacks is
the voice lxm itself.

**What the code declares today.**

| Fact | Where |
|------|-------|
| Five voice NSIDs are declared | `packages/app-lite/src/lib/scopes.ts:156-162` |
| `VOICE_SCOPES` derives one `rpc:…?aud=*` token per NSID | `packages/app-lite/src/lib/scopes.ts:163` |
| Those tokens are declared in the metadata ceiling (so no metadata rebuild is needed later) | `packages/app-lite/src/lib/scopes.ts:416` |
| They are listed in `UNREGISTERED_SCOPES` — declared but absent from the deployed HappyView API client's allowlist | `packages/app-lite/src/lib/scopes.ts:197-201` |
| The `voice` tier sits in `DEFERRED_SCOPE_SETS`, not `REQUESTABLE_SCOPE_SETS` | `packages/app-lite/src/lib/scopes.ts:307-317` |
| `CAPABILITY_SCOPES` omits voice, and a login's requested scope is `base` ∪ the extras of enabled capabilities — so no login requests them | `packages/app-lite/src/lib/scopes.ts:375-378`, `:685-697` |
| The client deliberately offers no consent dialogue for voice | `packages/app-lite/src/lib/components/voice/VoiceRoomPanel.svelte:73-84` |

**The order that works.** Registering out of order breaks sign-in for every
user, not just the pilot: HappyView custodies the granted session at
`POST /oauth/sessions` and rejects the *whole* granted set when any one token is
missing from the client allowlist
(`400 {"error":"scope '<token>' is not allowed for this client"}`), which the
browser surfaces as `OAuthCallbackError: Failed to register session`
(`packages/app-lite/src/lib/scopes.ts:22-34`).

1. **Register the five voice tokens on the HappyView API client.** The
   procedure is documented beside the code that tracks the state:
   `GET /admin/api-clients` to find the client id, then
   `PUT /admin/api-clients/{id}` with `{"scopes": "<existing scopes> <new>"}`
   (`packages/app-lite/src/lib/scopes.ts:190-195`; the same two-gate procedure
   is stated in `AGENTS.md`). The tokens to add are exactly the strings built at
   `scopes.ts:163`: `rpc:space.roomy.voice.getToken?aud=*`,
   `…getParticipants?aud=*`, `…getActiveCalls?aud=*`, `…join?aud=*`,
   `…leave?aud=*`.
2. **Move the tier into the requestable set and delete its tokens from
   `UNREGISTERED_SCOPES`** — `DEFERRED_SCOPE_SETS.voice` →
   `REQUESTABLE_SCOPE_SETS.voice` (`packages/app-lite/src/lib/scopes.ts:307-317`,
   `:197-201`). `packages/app-lite/scripts/check-oauth-scopes.mjs:59-69` fails
   the build when a requestable tier contains a token still listed in
   `UNREGISTERED_SCOPES`, so reversing the order cannot ship silently.
3. **Make a login actually request them.** Un-deferring the tier alone changes
   nothing: the requested scope is built from `base` plus `CAPABILITY_SCOPES`
   (`packages/app-lite/src/lib/scopes.ts:685-697`, `:375-378`), and voice is in
   neither. Voice must appear as a capability (or in `base`) before any session
   can hold the tokens — this is a code change, and it is not part of this
   runbook.
4. **Re-authenticate pilot users after step 1.** A grant is fixed at
   authorization time; sessions that signed in before registration hold no voice
   tokens.

**What a person sees if gate (d) is still open.** The voice RPC returns 403, and
`connectionErrorMessage` reports it as a permission problem rather than a
transport problem — "Voice permission missing / This session is not allowed to
use Roomy's voice endpoints" (`packages/app-lite/src/lib/voice/voice-errors.ts:151-160`),
recognised by the narrow scope-miss predicate in
`packages/app-lite/src/lib/scope-guard.ts:37-44`, `:80`. Seeing that toast means gates
(a) and (b) can be assumed fine and the grant is the problem.

---

## 2. Appserver variables

Source of truth: `packages/appserver/src/voice/livekit.ts:44-56`. Placeholders
below; never commit real values.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `LIVEKIT_URL` | yes | — | The SFU origin **as clients reach it**, e.g. `wss://livekit.example.com`. Trailing slashes are stripped (`livekit.ts:50`). Handed to the client in `getToken`'s `livekitUrl` (`packages/appserver/src/handlers/space.roomy.voice.getToken.ts:101`). Also the base for the appserver's own API calls: `ws`→`http` is rewritten and `/twirp/…` is POSTed to the same host (`packages/appserver/src/voice/livekitClient.ts:40-46`, `:74`). Same host must therefore serve **both** WSS and HTTPS. |
| `LIVEKIT_API_KEY` | yes | — | Signs participant tokens (`packages/appserver/src/voice/tokens.ts:129`, `:148-150`) and the appserver's service token (`livekitClient.ts:98-113`). Must exist in the LiveKit server's `keys:` map. |
| `LIVEKIT_API_SECRET` | yes | — | The HMAC secret for the key above. |
| `LIVEKIT_WEBHOOK_SECRET` | no | value of `LIVEKIT_API_SECRET` | Only when the webhook is signed with a different key than the one the appserver mints with (`livekit.ts:53`). Wrong value ⇒ every webhook is refused with 401 (`packages/appserver/src/voice/webhook.ts:154-156`). |
| `LIVEKIT_SERVER_ID` | no | `"roomy"` | First segment of the LiveKit room name, `{serverId}.{spaceId}.{roomId}@{callId}` (`packages/appserver/src/voice/tokens.ts:27-34`). Two deployments sharing one LiveKit project **must** differ: a webhook whose server segment is not ours is ignored (`packages/appserver/src/voice/tokens.ts:94-105`, `webhook.ts:59-66`). |

The three connection values are required **together**: with any one missing the
config is `null` (`packages/appserver/src/voice/livekit.ts:45-48`) and every
voice path takes its unconfigured branch:

| Path | Unconfigured behaviour | Source |
|------|------------------------|--------|
| `space.roomy.voice.getToken` | every field null | `packages/appserver/src/handlers/space.roomy.voice.getToken.ts:44-50`, `:74-75` |
| `space.roomy.voice.getParticipants` | empty list, null callId | `packages/appserver/src/handlers/space.roomy.voice.getParticipants.ts:50-52` |
| `space.roomy.voice.getActiveCalls` | empty list | `packages/appserver/src/handlers/space.roomy.voice.getActiveCalls.ts:44` |
| Room lister used by the reconciler | no rooms, no failures | `packages/appserver/src/voice/livekitClient.ts:34-38` |
| `POST /webhooks/livekit` | `503 {"error":"LiveKit is not configured"}` | `packages/appserver/src/voice/webhook.ts:150-153` |

The config is read **once**, during `createAppserver`
(`packages/appserver/src/appserver.ts:687-694`, `livekit.ts:63-66`), and the
reconciler is started only when background workers are on
(`appserver.ts:902-916`). Changing these variables requires a restart.

The Rust worker reads the same four variables with the same defaults and no
webhook secret — `crates/space-xrpc/src/handlers/voice.rs:59-69` — because it
serves reads only and the write ingress owns `space.roomy.voice.join`
(`crates/space-xrpc/src/handlers/voice.rs:10-16`).

---

## 3. LiveKit server configuration

A minimal single-node production config. The key/secret pair is **yours to
define** — nothing hands one out; it is a shared secret between the LiveKit
server's `keys:` map and the appserver's `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.

```yaml
# livekit.yaml — placeholders only
port: 7880

rtc:
  tcp_port: 7881
  # Either a UDP mux on one port …
  udp_port: 7882
  # … or the default media range (do not set both):
  # port_range_start: 50000
  # port_range_end: 60000

  # In a bridged container the process sees a private address; LiveKit must be
  # told the public one or it advertises an unreachable ICE candidate.
  use_external_ip: true
  # If STUN discovers the wrong address, use this pair instead:
  # use_external_ip: false
  # node_ip: 203.0.113.10

keys:
  # <api-key>: <api-secret>  — must match LIVEKIT_API_KEY / LIVEKIT_API_SECRET
  APIxxxxxxxx: <api-secret>

webhook:
  api_key: APIxxxxxxxx          # must be one of the keys above
  urls:
    - https://api.example.com/webhooks/livekit

# Optional: required for more than one LiveKit node.
# redis:
#   address: redis.example.internal:6379

# Optional: embedded TURN, for clients behind restrictive firewalls.
# turn:
#   enabled: true
#   domain: turn.example.com
#   tls_port: 5349
#   cert_file: /etc/livekit/turn.crt
#   key_file: /etc/livekit/turn.key
```

Field meanings and defaults come from the vendor's sample config —
<https://github.com/livekit/livekit/blob/master/config-sample.yaml>:

- `rtc.tcp_port` — "when set, LiveKit enable WebRTC ICE over TCP when UDP isn't
  available"; the same file notes "this port *cannot* be behind load balancer or
  TLS, and must be exposed on the node".
- `rtc.use_external_ip` — "attempts to discover the host's public IP via STUN",
  for hosts whose internal address maps to an external one.
- `rtc.node_ip` — "there are cases where the public IP determined via STUN is
  not the correct one"; the file states `use_external_ip` takes precedence, so
  set `use_external_ip: false` for `node_ip` to take effect.
- `webhook.api_key` — "the API key to use in order to sign the message … this
  must match one of the keys LiveKit is configured with"; `webhook.urls` is the
  list of notification targets.
- `redis.address` — "when redis is set, LiveKit will automatically operate in a
  fully distributed fashion".

`cert_file`/`key_file` appear **only** under `turn:` in that file, and only as
"optional (set only if not using external TLS termination)" — see §4.

Webhook semantics, from
<https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>:
LiveKit POSTs a JSON body of `WebhookEvent` with content type
`application/webhook+json`, and "these requests have an `Authorization` header
containing a signed JWT token. The token includes a sha256 hash of the payload".
The appserver verifies exactly that shape — HMAC over the token, then the
`sha256` claim against the raw body — in
`packages/appserver/src/voice/tokens.ts:166-209`. Because the hash is over the
**raw** body, whatever terminates TLS in front of the appserver must not
re-serialise it.

Delivery is best-effort with retries ("there are no guarantees around delivery …
LiveKit aims to mitigate transient failures by retrying"), which is why the
appserver returns 500 on a failed fact write so LiveKit retries
(`packages/appserver/src/voice/webhook.ts:165-176`) and runs a 30 s reconciler
against the SFU as a second corrective path
(`packages/appserver/src/voice/reconciler.ts:35-38`,
`packages/appserver/src/appserver.ts:902-916`).

Run the official image:

```bash
docker run --rm --network host \
  -v /etc/livekit/livekit.yaml:/etc/livekit/livekit.yaml:ro \
  livekit/livekit-server --config /etc/livekit/livekit.yaml
```

`--config` is the documented production invocation
(<https://docs.livekit.io/transport/self-hosting/deployment/>), the image name
and upgrade path match the vendor's VM guide
(<https://docs.livekit.io/transport/self-hosting/vm.md>), and host networking is
the vendor's recommendation for Dockerized deployments ("host networking should
be used for optimal performance", deployment guide). With `--network host` the
`rtc` ports bind directly on the host; with bridge networking every port in §4
must be published explicitly *and* LiveKit must still be told its public
address.

---

## 4. Ports and TLS

| Port | Proto | Purpose | Exposure |
|------|-------|---------|----------|
| 7880 | TCP | Signalling (WebSocket) **and** the HTTP/Twirp API the appserver calls | Behind the TLS-terminating proxy; never published raw |
| 7881 | TCP | ICE over TCP — fallback when UDP is blocked | Published on the host's public IP; cannot traverse the TLS proxy |
| 7882 | UDP | ICE/UDP mux (all media on one port) | Published on the host's public IP |
| 50000-60000 | UDP | Default ICE/UDP media range, when the mux is not used (two ports per participant) | Published on the host's public IP |
| 5349 / 3478 | TCP / UDP | Optional embedded TURN over TLS / UDP | Published, or 443 when there is no L4 load balancer |
| 443 | TCP | Where users' browsers reach signalling via the proxy | Occupied by the reverse proxy (and by TURN only if you move the proxy) |

Source for the defaults and for "the appserver needs 7880 too":
<https://docs.livekit.io/transport/self-hosting/ports-firewall/>, plus
`packages/appserver/src/voice/livekitClient.ts:40-46` (the appserver POSTs
`/twirp/livekit.RoomService/ListRooms` and `/ListParticipants` to the same
origin as the client-facing WSS URL).

**The official image does not terminate TLS for the signalling port in
production.** `config-sample.yaml` says of `port: 7880`, "for production setups,
this port should be placed behind a load balancer with TLS", and the only
`cert_file`/`key_file` keys in that file are under `turn:`. The ports reference
says the same: "This port should be placed behind a load balancer that can
terminate SSL." The deployment guide likewise requires "HTTPS/SSL termination
with a load balancer or reverse proxy", with a certificate "signed by a trusted
certificate authority; self-signed certs do not work here"
(<https://docs.livekit.io/transport/self-hosting/deployment/>).

So TLS comes from your proxy or from the platform's edge. A Caddy site block:

```caddyfile
# /etc/caddy/Caddyfile — placeholders only
livekit.example.com {
	reverse_proxy 127.0.0.1:7880
}
```

`reverse_proxy` handles the WebSocket upgrade ("performing the HTTP upgrade
request then transitioning the connection to a bidirectional tunnel") —
<https://caddyserver.com/docs/caddyfile/directives/reverse_proxy>. Ordinary HTTP
`POST /twirp/…` requests to the same host pass through unchanged, which is what
the appserver's room listing needs.

The ICE ports are the part that cannot be proxied: they are host candidates
advertised to the browser as `<node_ip>:<port>`. Publish them on the host's
public IP, and make sure the address the server advertises is the address the
browser can reach — that is the `use_external_ip` / `node_ip` decision in §3.
Get it wrong and signalling connects, media never does.

---

## 5. Platform constraints

Two of the three common hosts cannot carry the SFU. The constraint in every case
is UDP ingress, and none of them can be worked around from inside this
repository.

### Railway

- Public networking is HTTP/HTTPS: "Public networking allows you to expose your
  Railway services to the internet via HTTP/HTTPS", with TLS-terminated domains
  — <https://docs.railway.com/networking/public-networking>.
- The only non-HTTP option is TCP Proxy: "TCP Proxy enables you to expose
  non-HTTP services", and it "requires specification of a port to which the
  traffic should be proxied. Railway then generates a domain and proxy port"
  — <https://docs.railway.com/networking/tcp-proxy>.
- The supported traffic types are HTTP/1.1, HTTP/2, and — via TCP Proxy — raw
  TCP; there is no UDP entry — <https://docs.railway.com/networking/public-networking/specs-and-limits>.
- The generated proxy port is **random** and the client must use it
  (`shuttle.proxy.rlwy.net:15140`): "The port number is provided by Railway and
  must be used when connecting. Only the hostname is replaced with your custom
  domain." LiveKit has no setting for a distinct external TCP port — it
  advertises `node_ip` at `rtc.tcp_port`
  (<https://github.com/livekit/livekit/blob/master/config-sample.yaml>), so the
  port the browser is told to dial is not the port Railway accepts.
- TCP Proxy also load-balances: "Incoming traffic will be distributed across all
  replicas in the closest region using a random load balancing algorithm" — an
  SFU's signalling and ICE for one participant would land on different replicas.

**Conclusion:** Railway can host the appserver, not the SFU. A deployment there
sets `LIVEKIT_URL` to a LiveKit instance hosted elsewhere.

### Cloudflare

- Published tunnel applications support HTTP, HTTPS, UNIX, TCP, SSH, RDP, SMB,
  HTTP_STATUS, BASTION, HELLO_WORLD — there is **no UDP** service type
  (<https://developers.cloudflare.com/tunnel/concepts/routing/index.md>,
  "Supported protocols"). WebSockets *are* supported
  (<https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/index.md>),
  so a tunnel can front signalling, but not media.
- Spectrum does carry L4 TCP and UDP, but "Custom TCP/UDP applications require
  an Enterprise plan with Spectrum as a paid add-on"
  (<https://developers.cloudflare.com/spectrum/index.md>).
- Realtime TURN is a relay for clients, not an endpoint for your SFU: "TURN acts
  as a relay point for traffic between WebRTC clients like the browser and SFUs"
  (<https://developers.cloudflare.com/realtime/turn/index.md>). Pointing clients
  at it does not give a privately-hosted LiveKit node a public ICE address.

**Conclusion:** Cloudflare's proxy can front signalling (WSS on 443) but cannot
carry ICE; only an Enterprise Spectrum subscription changes that.

### The two deployments that work

| Option | What you provision | What goes into the appserver |
|--------|--------------------|------------------------------|
| **LiveKit Cloud** (managed) | A project at <https://cloud.livekit.io>; no servers, no ports, no TURN of your own | `LIVEKIT_URL` = the project's WSS URL, found on the project settings page (<https://docs.livekit.io/intro/basics/connect.md>); `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` = a key/secret pair created in that project (**unverified**: the exact dashboard path for key creation is not stated in the pages cited here). Add a webhook to `https://<appserver>/webhooks/livekit` with a signing API key (<https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>, "LiveKit Cloud" section). |
| **VM with a public IP** (self-hosted) | A compute-optimised VM, the official `livekit/livekit-server` image, §3's config, and the firewall opened for 80/443 TCP, 7881 TCP, 3478 UDP, 50000-60000 UDP (the vendor's list for a VM install: <https://docs.livekit.io/transport/self-hosting/vm.md>, "Firewall") | `LIVEKIT_URL` = `wss://livekit.example.com` (the proxied signalling origin), plus the key/secret from §3. Webhook lives in the config file, not the dashboard. |

LiveKit Cloud is the smaller change: one env block plus a dashboard webhook, and
no port or ICE reasoning. The VM is the option that keeps media on infrastructure
you control, at the cost of §4.

---

## 6. Verification chain

Run the steps in order. Each one adds a distinct fact, and the first three
answers look like success while proving much less than they appear to. Replace
`<appserver>` with your appserver origin.

### Step 1 — the route exists and the appserver is unconfigured

```bash
curl -i -X POST https://<appserver>/webhooks/livekit \
  -H 'content-type: application/webhook+json' -d '{}'
```

Expected before `LIVEKIT_*` is set:

```
HTTP/2 503
{"error":"LiveKit is not configured"}
```

The route is registered unconditionally
(`packages/appserver/src/appserver.ts:1238-1247`) and the 503 comes from
`packages/appserver/src/voice/webhook.ts:150-153`.

**Proves:** the appserver is reachable at that path and has no config. Nothing
about TLS on the LiveKit side.

### Step 2 — the appserver has a config and refuses unsigned requests

Same command, after setting `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and restarting:

```
HTTP/2 401
{"error":"Invalid webhook signature"}
```

`packages/appserver/src/voice/webhook.ts:154-156`.

**Proves:** the config parsed (`getLiveKit()` is non-null). It does **not** prove
the webhook secret matches LiveKit's, because an unsigned request is refused
either way. To distinguish, send a real event — LiveKit Cloud's "Send a test
event" action
(<https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>)
or a retry from a real call — and expect `200 {"ok":true}`. A 401 on a
LiveKit-signed event means `LIVEKIT_WEBHOOK_SECRET` (or the `api_key` in the
`webhook:` block) is wrong.

Note also that a webhook whose room name does not start with your
`LIVEKIT_SERVER_ID` is accepted and ignored with 200
(`packages/appserver/src/voice/webhook.ts:59-66`) — silence is not proof of
delivery.

### Step 3 — `getToken` mints instead of returning nulls

Call `space.roomy.voice.getToken` with a `roomId` as a signed-in member.

| Response | Meaning | Source |
|----------|---------|--------|
| all five fields `null` | LiveKit unconfigured — gate (a) is not closed | `packages/appserver/src/handlers/space.roomy.voice.getToken.ts:44-50`, `:74-75` |
| `token`, `callId`, `livekitUrl`, `e2eeKey`, `ttl` non-null | configured; the room's call was started by this request | `packages/appserver/src/handlers/space.roomy.voice.getToken.ts:78-106` |
| 403 `ScopeMissingError` / "not authorized for …" | gate (d): the grant lacks the voice lxm | §1.4, `packages/app-lite/src/lib/scope-guard.ts:37-57`, `:80` |
| 409 `CallNotStarted` | the deployment serving this query is the Rust worker, which mints only for a call that already exists | `crates/space-xrpc/src/handlers/voice.rs:336-348` |

The 409 is worth reading carefully: in the Rust worker, starting a call is the
write ingress's job, so `getToken` on a room with no projected call answers
`CallNotStarted` and points at `space.roomy.voice.join`
(`crates/space-xrpc/src/handlers/voice.rs:336-348`). In the TypeScript appserver
the same query starts the call itself
(`packages/appserver/src/handlers/space.roomy.voice.getToken.ts:78-82`). Both
mean "configured"; neither means "media works".

**Proves:** minting, E2EE key creation, and the room-name scheme. The token is a
local HMAC JWT — `mintLiveKitToken` makes no network call
(`packages/appserver/src/voice/tokens.ts:112-156`) — so this step also does not
prove the SFU is reachable or that the key/secret matches it.

### Step 4 — the appserver can talk to the SFU

Only exercised by the reconciler, so look for it rather than curling it: start
a call, wait one 30 s pass
(`packages/appserver/src/voice/reconciler.ts:35-38`), and confirm no repeated
`LiveKit livekit.RoomService/ListRooms failed` errors
(`packages/appserver/src/voice/livekitClient.ts:84-88`).

**Proves:** `LIVEKIT_URL`'s host serves HTTPS at `/twirp/…` and the key/secret
is accepted by the SFU. This is the check that catches an `LIVEKIT_URL` that is
the browser-facing WSS origin only (proxy not forwarding `/twirp`), or a key
pair that was minted against a different project.

### Step 5 — two browsers actually hear each other

Two signed-in members with the flag on, same space and room, both press join.

Expected: each participant list shows both DIDs, audio flows both ways, and
leaving removes each from the other's list.

**Proves:** the whole media path — ICE candidate advertisement
(`use_external_ip`/`node_ip`), UDP reachability, E2EE key setup
(`packages/app-lite/src/lib/voice/VoiceCallState.svelte.ts:231-285`, which loads
the media SDK and connects with the minted token and key), and webhook
confirmation of the joins. This is the only step that fails when §4's UDP ports
are closed, and the only one that fails with a *working* token.

---

## 7. Rollout

Do not enable the flag globally on the first deploy.

1. **Finish gates (a)–(d) for a pilot set of DIDs.** Scopes first (§1.4), then a
   fresh login for those users, then the flag.
2. **Pilot.** `space.roomy.admin.setFlag` with `all: false` and an explicit
   `userDids` list — the procedure replaces the per-user assignment list and
   leaves the global switch alone
   (`packages/appserver/src/handlers/space.roomy.admin.setFlag.ts:1-11`, `:47-72`).
   It is authorised against the `APPSERVER_ADMIN_DIDS` allowlist
   (`packages/appserver/src/handlers/space.roomy.admin.setFlag.ts:34`,
   `packages/appserver/src/admin.ts:16-32`); with that variable unset, every
   admin endpoint rejects all requests (`admin.ts:24-28`).
3. **Watch the pilot.** A call that connects but has no audio is §4 (UDP / ICE
   address); a call that cannot be joined at all with a "Voice permission
   missing" toast is §1.4; a call nobody can start is gate (c).
4. **Widen.** Set `all: true`. No further prerequisite applies: the SFU and
   webhook are already live, and the client issues no voice RPC until the flag
   is on (`SpaceSidebar.svelte:94-96`).

**Retroactivity does not apply here.** Nothing about voice is stored per user:
call facts are per call, in the space's projection, and a session's ability to
join depends only on its OAuth grant. Enabling the flag later is the flag flip
itself — there is no per-user backfill to run and no historical state to repair.

**Rollback.** `space.roomy.admin.clearFlag` disables the flag outright
(`packages/appserver/src/handlers/space.roomy.admin.clearFlag.ts:24`); unsetting
the `LIVEKIT_*` variables and restarting degrades instead of failing — the
appserver "returns nulls, reads return empty, and the client renders no call
affordances" (`packages/appserver/src/voice/livekit.ts:4-8`). Note that the appserver never creates or deletes
LiveKit rooms — its only API calls are the two listings
(`packages/appserver/src/voice/livekitClient.ts:44-55`) — so in-flight rooms
survive until LiveKit's own `empty_timeout` / `departure_timeout` close them
(<https://github.com/livekit/livekit/blob/master/config-sample.yaml>, `room:`
block).

## References

- Plan and host/architecture decisions: [`docs/plans/voice-chat-plan.md`](../../../docs/plans/voice-chat-plan.md)
- Appserver deployment notes: [`packages/appserver/README.md`](../README.md)
- OAuth scopes and the two gates: `packages/app-lite/src/lib/scopes.ts` and `AGENTS.md`
- LiveKit server: <https://docs.livekit.io/transport/self-hosting/deployment/>, <https://docs.livekit.io/transport/self-hosting/ports-firewall/>, <https://docs.livekit.io/transport/self-hosting/vm.md>
- LiveKit config surface: <https://github.com/livekit/livekit/blob/master/config-sample.yaml>
- LiveKit webhooks: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>
- Atproto permissions: <https://atproto.com/specs/permission>
- Railway networking: <https://docs.railway.com/networking/public-networking>, <https://docs.railway.com/networking/tcp-proxy>, <https://docs.railway.com/networking/public-networking/specs-and-limits>
- Cloudflare: <https://developers.cloudflare.com/tunnel/concepts/routing/index.md>, <https://developers.cloudflare.com/spectrum/index.md>, <https://developers.cloudflare.com/realtime/turn/index.md>
