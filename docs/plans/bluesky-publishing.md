# Publishing to Bluesky as the Space Account — Plan

**Date:** 2026-09-16
**Status:** Draft for review. **No implementation.** This document changes no production code.
**Author:** Sorrel (TASK-138), for Meri.
**Verified against:** `origin/next` @ `c7087ea9`.
**Slots into:** `packages/appserver/docs/plans/arbiter-integration.md` (Phases 0–4) — read that first. This plan is a *new* phase that consumes that plan's shipped machinery; it does not replace or restate it.

**Path choice.** This document lives at `docs/plans/bluesky-publishing.md`. Rationale: the root `docs/plans/` directory holds the cross-package plan documents (`richtext-migration-plan.md`, `voice-chat-plan.md`, `client-migration-plan.md`), while `packages/appserver/docs/plans/` holds appserver-scoped ones. Publishing touches `packages/sdk` (exporter, arbiter client), `packages/appserver` (opt-in storage, sweeper, mapping table), and `packages/app-lite` (the share affordance) — three packages, so the root directory is correct. Say the word if you want it moved beside `arbiter-integration.md` instead.

---

## 0. Status: the space already has a Bluesky identity; nothing publishes with it

### 0.1 What is built

The arbiter half is shipped. A Roomy space *is* a real ATProto account on the Roomy PDS, reachable only through the arbiter's policy proxy.

| Capability | Evidence |
|---|---|
| Provision a space as a real PDS account | `packages/appserver/src/arbiter/provision.ts:46` (`provisionSpace` → `createArbiter`, `resetConfig`, `proxy`) |
| Act as the space on its PDS | `packages/sdk/src/atproto/arbiter.ts:97` (`ArbiterClient`), `:156` (`proxy`), posting to `town.muni.arbiter.proxy` with a per-request single-use serviceAuth token (`:140-150`) |
| Write a record under the space's repo | `packages/sdk/src/atproto/bluesky-profile.ts:101` — `putRecord` via `arbiter.proxy`; the only `app.bsky.*` writes anywhere in the repo |
| Upload a blob to the space's repo | `packages/sdk/src/atproto/bluesky-profile.ts:41` (`uploadBlobToSpace`), `:48` (`com.atproto.repo.uploadBlob`) |
| Set the space's handle | `packages/sdk/src/atproto/space-handle.ts:77` (`setSpaceHandle` → `com.atproto.identity.updateHandle`) |
| Server-side proxy helper | `packages/appserver/src/arbiter/client.ts:136`; used exactly once today, at `packages/appserver/src/arbiter/provision.ts:60-72` |
| UI surface | `packages/app-lite/src/routes/[space]/settings/integrations/+page.svelte:101` — "Create/Update Bluesky Profile", gated by the `space-account-management` flag (`:18-20`) and `isAdmin` (`:14`) |

### 0.2 What does not exist

**No code anywhere publishes a post.** The falsifiable grep, run against `origin/next`:

```bash
git grep -n "app\.bsky\.feed\.post" origin/next
```

returns exactly two hits, both prose:

- `docs/plans/richtext-migration-plan.md:160`
- `docs/rich-text-representation-research.md:136`

and zero writers. Supporting greps, also against `origin/next`:

```bash
git grep -n "bskyPost\|publishSweeper\|createRecord\|outbox" origin/next -- 'packages/**'   # → only a doc comment in pending-sends.svelte.ts:26
git grep -n "town\.muni\.arbiter\.policy" origin/next                                      # → only the AT-URI string, provision.ts:35
git grep -in "\.rego\b\|package arbiter" origin/next | grep -v arbiter-integration.md       # → nothing
git grep -n "maxGraphemes\|grapheme\|Intl\.Segmenter" origin/next -- 'packages/**'          # → only profile lexicons + PUSH_MAX_MESSAGE_AGE_MS
```

There is no publish table, no outbox, no dedupe table for "this message was posted", and no character-limit machinery of any kind on messages.

### 0.3 What is already researched and must not be redone

`docs/plans/richtext-migration-plan.md:160` (in §3.5, "Tradeoffs accepted") already states the hard part of the export:

> **Explicit share/crosspost (Roomy → `app.bsky.feed.post`)**: the exporter must map features to Bluesky's closed union at export time (drop typography/`#roomRef`, `#didMention`→`#mention`, `#link`→`#link`) and rebase indices to post-global offsets — work that was never actually saved by the twins (§3.5 analysis above). No change to the Roomy record itself.

That analysis **still holds against the current representation**, and §2 below is an implementation of it rather than a re-derivation. It holds because:

- Roomy's facet byte semantics are *identical* to Bluesky's (`space.roomy.richtext.facet#byteSlice` is UTF-8, `byteStart` inclusive / `byteEnd` exclusive — `packages/sdk/src/schema/richtext/index.ts:24`, and `packages/appserver/lexicons/space/roomy/richtext/facet.json:4` says so explicitly, citing `app.bsky.richtext.facet#byteSlice`).
- Roomy deliberately did *not* emit `app.bsky.*` facet twins (`docs/plans/richtext-migration-plan.md:147-161`, decision at `:151-155`), so the exporter is the only place the mapping can happen.
- The index-space mismatch is real and unchanged: Roomy facets are **per-block** (`packages/sdk/src/schema/richtext/index.ts:117` — `Facet` indexes into *a block's* `text`), while `app.bsky.feed.post` facets are **post-global**.

The delta this plan adds is what that cited line does not cover: **how the blocks are flattened into one post text without destroying the offsets**, what to do about Bluesky's 300-grapheme limit, what triggers a publish, and how a publish is made idempotent.

---

## 1. Per-space opt-in

### 1.1 The constraints that decide the design

Three facts from the repo settle most of this.

**(a) The existing feature-flag system cannot express a per-space opt-in, and is not a security boundary.** Flags are keyed by `(flag_key, user_did)` only (`packages/appserver/src/db/readStateSchema.sql:167-182`), and `space.roomy.getFlags` takes no space argument (`packages/appserver/src/handlers/space.roomy.getFlags.ts:21-33`). The docs say both things outright:

- `packages/docs/src/routes/concepts/feature-flags/+page.svelte:198-201` — "**Not a security boundary.** The appserver does not consult flags when authorizing events; a gate is a UI affordance."
- `packages/docs/src/routes/concepts/feature-flags/+page.svelte:204-206` — "**Not per-space.** `getFlags` takes no space argument, so a flag can't be enabled for one community only."

**Therefore: `space-account-management` rides along for UI availability only.** Publishing does not get its own flag and does not depend on being able to express per-space state through flags; it needs real space state. What the flag *does* legitimately control is whether an admin sees the publishing controls at all during rollout — exactly as it gates the integrations tab today (`packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:156-161`, `+page.svelte:18-20`). The UI gate is `space-account-management` **AND** `isAdmin`, per the existing precedent at `SpaceSidebar.svelte:159-161`.

**(b) The per-space DB is wiped on a schema bump; the global DB is not.** `packages/appserver/src/db/db.ts:28-31`:

> Per-space DB schema version (`data/spaces/*.sqlite`). Bump whenever `schema-space.sql` changes — a bump wipes and re-derives every per-space DB (from the event log via re-materialisation).

The rebuild replays the stream from `idx 0` and swaps the file (`packages/appserver/src/streams/reMaterialize.ts:110-127`, `:263-265`). The global DB, by contrast, is explicitly never wiped (`packages/appserver/src/db/globalVersions.ts:1-10`). **This single asymmetry decides §3's storage question and it also decides this one**: any setting that must survive a rebuild has to be either (i) in the event log, or (ii) in the global DB. It must *not* be a directly-written per-space column.

**(c) The repo has a precedent for each, and one bad precedent.** `comp_space.handle` is written by a direct `SQL UPDATE` in the `space.roomy.space.setHandle` procedure (`packages/appserver/src/handlers/space.roomy.space.setHandle.ts:69-77`) — i.e. **not** reconstructible from the event log, and therefore lost on a schema bump. By contrast `comp_space.handle_provider` is written by an event (`space.roomy.space.setHandleProvider.v0` → `update comp_space set handle_provider = …`, `packages/sdk/src/schema/events/space.ts:405-412`) and survives a rebuild because it is re-materialised from `stream_events`. The same contrast shows up in the *default* convention: `allow_public_join` is `NULL` = unset, defaulted in code by `coalesce(allow_public_join, 1)` (`packages/appserver/src/db/schema-space.sql:85`, `packages/appserver/src/auth/access.ts:195-206`) — i.e. **unset means OPEN**, which is precisely the default shape publishing must not copy.

### 1.2 Recommendation

**Store the opt-in as an event, materialised into `comp_space`.** Specifically:

- **Event (recommended):** a dedicated `space.roomy.space.setPublishTarget.v0` carrying `{ enabled: boolean, targets?: [...] }`. A dedicated NSID rather than extending `space.roomy.space.updateSpaceInfo.v0`, because a publishing toggle is not "space basic info" and because a dedicated event gets its own invalidation signal without touching the one every space-settings save already emits (`packages/appserver/src/invalidation/inferSignals.ts:751-757`, registered at `:1058`).
- **Alternative considered:** extend `updateSpaceInfo` to a `.v1` adding `publishToBluesky?: boolean | null`. This has the strong advantage of an *existing* precedent for versioning an event in place — `space.roomy.space.updateSidebar.v0` → `.v1` are both registered and both materialised (`packages/sdk/src/schema/events/registry.ts:72-73`, `packages/sdk/src/schema/events/space.ts:214` and `:246`), and the materialiser already does partial updates (only fields `!== undefined` are written — `space.ts:151-161`, `:198-204`). It is defensible; it is rejected here only because it couples the publishing toggle's invalidation and write-auth surface to a general-purpose settings event.
- **Whatever the NSID, three registrations are mandatory** (this is the complete checklist for a new space-config event, and it is not obvious): `packages/sdk/src/schema/events/registry.ts` (schema + materialiser), `packages/appserver/src/auth/writeAuth.ts:47` (`ALLOWED_TYPES`, or the event is rejected at the `sendEvents` boundary) **and** `writeAuth.ts:146-165` (`SPACE_MANAGE_TYPES`, so it is admin-gated — without this the event is allowed for any authenticated caller with space access), and `packages/appserver/src/invalidation/inferSignals.ts` (the signal registry at `:1055-1090`). `SPACE_MANAGE_TYPES` is the mechanism by which `updateSpaceInfo` and `setHandleProvider` are already admin-only (`writeAuth.ts:147`/`:150`, dispatched at `:749-752`).
- **Read path:** add the flag to `space.roomy.space.getMetadata`'s `comp_space` select (`packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:130-142`, returned at `:332-348`, alongside the existing `isAdmin: access.isAdmin` at `:343`). That is the one query every space-settings surface already runs.
- **Adding the column to `comp_space` requires a `SPACE_SCHEMA_VERSION` bump** (`packages/appserver/src/db/db.ts:31`), which wipes and re-derives every per-space DB. That is acceptable *only because the state is event-sourced* — it is re-derived from the log. It would be unacceptable for a directly-written column. Note also that the schema exec runs idempotently on every open when the version already matches (`packages/appserver/src/db/worker.ts:154-157`), so a table-with-no-ALTER change heals without a bump; a new `comp_space` column is the case that does need one.

### 1.3 Default for existing spaces: OFF, fail-closed

**Existing spaces must not start posting.** The mechanism: the new column is `NULL`-able with the read defaulting to **false** (`coalesce(publish_enabled, 0)`), the *opposite* of the `allow_public_join` convention at `access.ts:193-206`. `NULL` = "this space predates publishing" = off.

This is not a stylistic preference. A default-open flag here means the first deploy turns every space into a Bluesky publisher, and every replayed historical message through the shared write path becomes a publish candidate — the same shape as TASK-151 (§3.3). Write the `coalesce(..., 0)` explicitly and test it, because the neighbouring column in the same table does the opposite and a copy-paste of that line is the plausible bug.

Additionally: publishing requires a stewarded account, and **there is no way to ask the appserver whether a space has one**. `grep -i arbiter` over every schema file in `packages/appserver/src/db/` returns nothing; the only trace is two records on the space's own repo — `town.muni.arbiter.service/self` (read by `packages/sdk/src/atproto/arbiter.ts:110-129`, which throws at `:125-127` when absent) and `space.roomy.service/self` (written at `packages/appserver/src/arbiter/provision.ts:58-72`, lexicon at `packages/appserver/lexicons/space/roomy/service.json`). Today a space without a steward renders as `hasProfile: false`, indistinguishable from a space with no profile, because `getSpaceProfileRecord` swallows the error (`packages/sdk/src/atproto/bluesky-profile.ts:83-86`). **The opt-in UI must not offer publishing for a space whose steward cannot be resolved**; either surface steward state in `getMetadata` or let the resolution failure render distinctly instead of being swallowed. Flagged as an open question (§6.4) — it is a small decision with a user-visible failure mode.

### 1.4 Opt-in shape: a per-space flag, not a new role capability

The repo's entire capability vocabulary is `SpaceAccess {isMember, isAdmin, isBanned}` and `RoomAccess {canRead, canWrite, …}` (`packages/appserver/src/auth/access.ts:20-59`), plus `DefaultAccess = "readwrite" | "read" | "none"` (`:18`) and role grants `permission IN ('read','readwrite')` (`packages/appserver/src/db/schema-space.sql:288`). **There is no capability registry, and no permission value beyond read/readwrite.**

So a "who may publish" capability has exactly three possible homes, all with real costs:

1. **A new boolean predicate in `access.ts`** (e.g. `mayPublish`), derived from an edge label or a role. Needs a new edge label or role-table semantics, plus write-auth wiring.
2. **A third value in `role_rooms.permission`** — a SQLite `CHECK` constraint change (`schema-space.sql:288`), which SQLite cannot `ALTER`, so it needs a table rebuild plus a `SPACE_SCHEMA_VERSION` bump and a global data migration (the precedent for exactly this dance is `federation_receiver_permissions.kind` at `packages/appserver/src/db/globalVersions.ts:56-58`). Broad blast radius for one capability.
3. **Admin-only, like every other space-level setting.**

**Recommendation for v1: (3), admin-only.** It matches every existing space-config precedent — `setHandle` and `updatePolicy` both gate on `requireSpaceAccess(...).isAdmin` (`packages/appserver/src/handlers/space.roomy.space.setHandle.ts:53-61`, `packages/appserver/src/handlers/space.roomy.space.updatePolicy.ts:49-57`) — and it defers the capability model to a real decision rather than inventing one inside a publishing feature. Whether *non-admin* members may share an individual message to the space's Bluesky account is a policy question, listed at §6.2.

---

## 2. The record shape: Roomy message → `app.bsky.feed.post`

### 2.1 Source shape (verified)

A Roomy message is not an ATProto record. It is a DRISL event, `space.roomy.message.createMessage.v0`, with an arktype schema and **no JSON lexicon** (`packages/sdk/src/schema/events/message.ts:15-21`; the appserver's `lexicons/` tree is documentation only, per `packages/appserver/docs/plans/sendEvents-procedure.md:176`). Its content is an opaque envelope:

```ts
// packages/sdk/src/schema/primitives.ts:91-95
Content = { mimeType: string, data: Bytes }
```

with two wire formats discriminated by `mimeType`:

- **Legacy:** `text/markdown` (or `text/plain`), decoded to a string by `decodeContent` (`packages/appserver/src/db/content.ts:20`) — non-`text/*` mime types are base64'd on the read API.
- **Current:** `application/vnd.roomy.richtext+json` (`packages/sdk/src/richtext/convert.ts:32`), UTF-8 JSON of `{ $type: "space.roomy.richtext.document", blocks }` (`convert.ts:1082-1092`), parsed by `deserializeBody` (`:1099`) or the appserver-side `decodeRichTextBody` (`packages/appserver/src/db/content.ts:45`).

Facets are generated **client-side** by `proseMirrorDocToBlocks(tiptap.getJSON())` (`convert.ts:291`; called from `packages/app-lite/src/lib/components/chat/ChatInput.svelte:124`). The server never constructs facets; it only decodes them for link detection, mention extraction, and plaintext (`packages/appserver/src/materialization/applyBatch.ts:554-566`, `packages/appserver/src/materialization/toAppliedEvent.ts:52-71`, `packages/appserver/src/push/evaluate.ts:140-146`). **A publish path must therefore handle both mime types**, and `markdownToBlocks` (`convert.ts:808`) is the existing legacy→blocks bridge if it needs one.

Facet features that exist today (`packages/sdk/src/schema/richtext/index.ts`):

| Roomy feature | Line | Payload |
|---|---|---|
| `#bold` / `#italic` / `#strikethrough` / `#underline` / `#code` / `#highlight` | `:32` `:37` `:42` `:47` `:52` `:57` | none |
| `#link` | `:62` | `uri` |
| `#didMention` | `:68` | `did` |
| `#atMention` | `:74` | `uri` |
| `#roomRef` | `:80` | `spaceId`, `roomId?` |

`#highlight` and `#atMention` are **producer-less and consumer-less** (type declarations and lexicon entries only; nothing emits or renders them) — they can be ignored without loss.

Blocks (`:125`–`:203`): `#text`, `#header`, `#blockquote`, `#small`, `#code`, `#orderedList`, `#unorderedList`, `#image`, `#horizontalRule`. Facets appear only on `#text` (`:125-130`), `#header` (`:132`), `#blockquote` (`:139`), `#small` (`:147`), and on list `items` (`:163-165`).

### 2.2 Target shape

`app.bsky.feed.post` (upstream lexicon: `bluesky-social/atproto` `lexicons/app/bsky/feed/post.json`, fetched 2026-09-16 — external, not in this repo):

```
record: { text (required), createdAt (required), facets?, embed?, reply?, langs?, labels?, tags? }
key: "tid"
text: maxLength 3000, maxGraphemes 300
```

`app.bsky.richtext.facet` (same source): `index: #byteSlice` (`byteStart` inclusive, `byteEnd` exclusive, **UTF-8 bytes, post-global**), `features: union[#mention{did}, #link{uri}, #tag{tag}]` — a **closed** union of three.

### 2.3 Feature mapping

This is `richtext-migration-plan.md:160`, made concrete:

| Roomy feature | → Bluesky | Note |
|---|---|---|
| `#link { uri }` | `#link { uri }` | Direct: same field name, same byte semantics (`index.ts:62` ↔ upstream `#link`). |
| `#didMention { did }` | `#mention { did }` | Direct. The *text* is display-only; upstream says the text "is usually a handle … but the facet reference is a DID". Roomy's text is `@${label}` where `label = attrs.label ?? attrs.id` (`convert.ts:130-137`), so a DID-shaped label renders oddly but resolves correctly. |
| `#bold` `#italic` `#strikethrough` `#underline` `#code` `#highlight` | **dropped** | Bluesky's union has no typography. Text survives. |
| `#roomRef { spaceId, roomId? }` | **dropped** | No Bluesky equivalent. Text survives. |
| `#atMention { uri }` | **dropped** | Producer-less; nothing to lose. |
| unknown `$type` | **dropped** | Roomy's union is open (`index.ts:91-113`); Bluesky's is closed. |

**Drop at feature granularity, not facet granularity.** One Roomy facet can carry several features: `marksToFeatures` (`convert.ts:160-227`) pushes *all* of a run's marks into one facet's `features` array, and an internal link mark produces `#link` **and** `#roomRef` on the same range (`:182-192`). So the rule is: map the features; keep the facet if ≥1 survived; drop the whole facet if none did. A facet whose features vanish must not be emitted with an empty `features` array — the union requires at least the declared shape, and upstream renderers would have nothing to index.

Consequence worth stating: a `channelThreadMention` emits **only** `#roomRef` (`convert.ts:200-221`, deliberately not also `#link`, to avoid nested `<a>`), so a Roomy channel mention becomes plain `#label` text on Bluesky. An internal *link* (a mark with `href` on a Roomy path) becomes a public `https://<app-origin>/<spaceId>/<roomId>` link — which works, since `parseInternalLinkHref` (`convert.ts:97`) accepts absolute URLs on any host with that path shape.

### 2.4 Flattening and rebasing — the part that must not be done carelessly

Roomy facets index into **one block's** `text` (`index.ts:117`); Bluesky facets index into the **whole post's** `text`. The exporter must therefore:

1. Flatten all blocks to a single string with a **deterministic, documented separator** (e.g. `"\n"` between blocks; `"\n"` between list items). Headings, quotes and code lose their structure — that is accepted, and is the same "drop to plain text" posture the rest of the repo takes for unknown blocks (`index.ts:198-206`).
2. Rebase each surviving facet by the running **UTF-8 byte length** of the emitted prefix (`utf8ByteLength`, `convert.ts:37`), not by character count and not by UTF-16 code units.
3. Emit `createdAt` from the **canonical** message timestamp, not the event ULID. `canonicalMessageTimestamp` (`packages/appserver/src/materialization/sortIdx.ts:216-223`) is the existing correct source — it honours `space.roomy.extension.timestampOverride.v0`, which is how bridged messages carry their true send time.

**Do not use `blocksToPlaintext` as the flattening substrate.** It is close, but it collapses whitespace and trims at the end (`convert.ts:655-677`; the final line is `parts.join(" ").replace(/\s+/g, " ").trim()`), which destroys the exact correspondence between text and byte offsets that the rebase depends on. It is the right function for push bodies and search text (its current callers — `packages/appserver/src/push/evaluate.ts:143`, `packages/appserver/src/search/text.ts:33`, `packages/appserver/src/queries/threadActivity.ts:362`) and the wrong one here. The exporter needs its own offset-preserving flatten, and it must be a **pure function** so it can be unit-tested against a message corpus without a network.

Because the exporter is pure and total, it should be written and tested **first**, before any network work — it is the only part of this feature with no failure modes beyond correctness.

### 2.5 Character limit: 300 graphemes

**Roomy has no message-length limit of any kind.** Verified: no `maxGraphemes`/`maxLength` on any message schema or extension; the composer has no `maxlength`; `Intl.Segmenter` appears nowhere in the repo; the only grapheme constraints are on *profile* fields (`packages/appserver/lexicons/space/roomy/user/profile.json:14-27`). The one comment that mentions character counting is on `blocksToPlaintext` (`convert.ts:654`) — and, as above, that function normalises whitespace, so it is not a faithful counter either.

So the exporter must introduce the limit, and there is no existing behaviour to match. Three options:

| Option | Behaviour | Failure mode |
|---|---|---|
| **Refuse** (recommended) | Over-limit messages are not publishable; the UI says why and the sweeper records a terminal `too_long` outcome | Members must split their own messages; a long message is simply not shareable |
| **Truncate** | Publish the first 300 graphemes | Silent content loss, on a permanent public record, and the facet rebase must also be clipped — a truncated facet whose `byteEnd` exceeds the text length is a malformed record |
| **Thread-split** | Emit N posts chained with `reply` strongRefs | Turns one message into N records; retraction becomes a set; partial failure mid-thread leaves a broken chain; needs the `reply` strongRef machinery of §2.6 |

Recommendation: **refuse**, for v1. Truncation is the only option that can silently publish something the author did not write, on a network Roomy does not control. Count with `Intl.Segmenter` (`granularity: "grapheme"`) — confirmed available in the runtime (a family emoji segments to 1 grapheme, `e`+combining acute to 1, vs 7 and 2 code points respectively) — and count the **flattened post text**, not the blocks.

### 2.6 Embeds

Bluesky's `embed` is a union of images / video / external / record / recordWithMedia, **one per post**. Roomy's embeds are derived rows keyed by URL, joined on read (`comp_embed_link` + `comp_embed_link_data`, `packages/appserver/src/db/schema-space.sql:199-221`; joined in `packages/appserver/src/queries/selectMessages.ts:292-333`), plus media attachments with `atblob://` URIs.

**Link cards map to `app.bsky.embed.external`, with one catch.** Upstream `external` requires `uri`, `title`, `description`; `thumb` is a **blob** ≤ 1 MB. Roomy's enriched card carries title `t`, description `d`, and thumbnails as **remote image URLs** (`imgs[0].u` / `thumb.u` — `packages/appserver/src/embed/metadata.ts:54-65`, full `EmbedV1` at `packages/appserver/src/embed/types.ts:67-97`). There is no blob anywhere in the embed path. So embedding a thumbnail requires fetching the remote image and uploading it via `uploadBlobToSpace` (`packages/sdk/src/atproto/bluesky-profile.ts:41-59`) — the same shape as the avatar path, which already fetches from an owner's PDS and enforces a 1 MB cap (`packages/app-lite/src/lib/mutations/bluesky-profile.ts:104-136`). `title` and `description` are required fields, so a card with neither cannot be embedded at all and must be dropped.

**Media attachments are a policy question, not a technical one.** Roomy image/video attachments are `atblob://<did>/<cid>` refs on the *author's* PDS (`packages/sdk/src/schema/extensions/message.ts:36-46`; `resolveBlobUrl` at `packages/app-lite/src/lib/utils.ts:25`). Publishing them under the *space's* account means the blob must be fetched from a user's PDS and re-uploaded into the space's repo — the mirror of `uploadAvatar` (`bluesky-profile.ts:104-121`, which fetches via public `com.atproto.sync.getBlob`). Technically straightforward (`app.bsky.embed.images` takes ≤4 blobs ≤2 MB with required `alt`). The question is authority: is a space admin permitted to re-host a member's image under the space's identity? **Recommendation: images and video are out of scope for v1** (§5, Not in scope), and the permission question is listed at §6.3.

**Replies are out of scope for v1.** Roomy replies are a `space.roomy.attachment.reply.v0` targeting a Roomy message ULID (`packages/sdk/src/schema/extensions/message.ts:21-24`). Bluesky's `reply` needs `root` + `parent` strongRefs (`uri` **and** `cid`) of *Bluesky* posts — which only exist if the replied-to Roomy message was itself published, so threading is a strict follow-on to the mapping table of §3.

**`langs`:** nothing in the repo detects language (grep for language detection returns nothing), so omit it in v1 rather than guessing.

---

## 3. What triggers a post — and the failure modes

### 3.1 The trigger options

| Option | Trigger | Failure modes |
|---|---|---|
| **A. Manual per-message share** | An admin clicks "Share to Bluesky" on one message; the client calls the arbiter proxy directly, as the integrations tab does today | Requires a human for every post, so it cannot mirror a conversation. Requires the client to hold message state and to survive a failure mid-flow. **But**: the caller DID the arbiter sees is a real human admin, which is the only identity the existing Rego policy can meaningfully evaluate (§4.2). |
| **B. Automatic per-room mirroring** | Every message in an opted-in room is published by the appserver | Scales to a real mirror. Publishes without a human in the loop, so a compromised or careless member posts to a public network under the space's identity with no confirmation. Needs the `mirror_from` watermark of §3.3 or the first enable re-publishes history. The appserver calls the arbiter as **itself**, which the policy may not permit (§4.2). |
| **C. Both** | A per-room auto-mirror toggle, plus a manual share for anything outside a mirrored room | Two paths, one mapping table, one sweeper. The union of A's and B's failure modes, but the auto path is off by default per room, so the blast radius of a mis-set auto toggle is one room. |

**Recommendation: C, sequenced A → B** (§5 Phases 3 and 4). Manual share first because it proves the whole chain (opt-in → export → arbiter write → mapping → retraction) with a human watching each step; automatic mirroring only after the mapping table has been shown to hold under replay. Note the hard dependency: Phase 4 additionally requires the policy answer at §6.1, while Phase 3 does not.

### 3.2 Idempotency: the requirement is stronger than any existing sweeper's

**A duplicate embed card is harmless; a duplicate post is not.** The repo's existing outbound sweeper — link-card enrichment (`packages/appserver/src/embed/sweeper.ts` + `enricher.ts`) — is idempotent *by construction* because enrichment is a pure function of the URL: re-fetching and re-storing the same card is a no-op. Publishing is not: a retried network call produces a second, permanently visible post. **The embed sweeper is the right *structure* to copy and the wrong *guarantee* to copy.**

So the publish path needs both belts:

**Belt 1 — a persisted mapping table, in the global DB.**

- Shape, mirroring the one durable external-id mapping the repo already has (`packages/discord-bridge/src/db/schema.ts:25-33`):

  ```sql
  CREATE TABLE id_mappings (
    space_did TEXT, kind TEXT, discord_id TEXT, roomy_id TEXT,
    PRIMARY KEY (space_did, kind, discord_id)
  );
  CREATE INDEX idx_mappings_roomy ON id_mappings (space_did, kind, roomy_id);
  ```

  with the **reverse index on `roomy_id`** — that is exactly the index that answers "has *this* Roomy message already been posted?", used by `getDiscordId` (`packages/discord-bridge/src/db/repository.ts:245`). The publish table should be `(space_did, message_id) → (post_uri, post_cid, published_revision, state)`, plus the attempts/retry columns of §3.4.

- **Home: the global DB.** Not the per-space DB. Because a `SPACE_SCHEMA_VERSION` bump wipes and re-derives every per-space DB (`packages/appserver/src/db/db.ts:28-31`), a mapping table there would lose every "already published" record on the next schema change — and a lost published-record is a **republish-everything event**. The global DB is explicitly never wiped on a bump (`packages/appserver/src/db/globalVersions.ts:1-10`); new global tables are added to `schema-global.sql` and get a manifest entry (`packages/appserver/src/db/globalVersions.ts:51-74`; the current entry is `"10": { kind: "structural" }` at `:71`). Use `kind: "structural"` — the idempotent schema exec creates the table on every open (`packages/appserver/src/db/worker.ts:154-157`), so no data migration is needed.
- **Discipline, copied verbatim from the bridge:** check before the side effect (`packages/discord-bridge/src/services/roomy-event-router.ts:317-320` — "Already bridged to Discord? Skip (prevents duplicates on restart/re-backfill)"), register **after** the send succeeds (`:463-470`).
- **Caveat that must be handled, not inherited:** the bridge's `stream_events` log has PK `(stream_id, idx)` and **no unique constraint on the event ULID** (`packages/appserver/src/db/eventsSchema.sql:3-12`), so the same logical event can be appended twice. Log-level dedupe is unavailable; the mapping table is the only dedupe.

**Belt 2 — a deterministic record key, so a retry is an *upsert*, not a duplicate.**

This is the improvement over "check then send". `app.bsky.feed.post`'s key is `"tid"`, and `putRecord` on an existing rkey **upserts** — the same property the profile write already relies on (`packages/sdk/src/atproto/bluesky-profile.ts:93` — "`putRecord` with rkey `self` upserts"). So:

- Derive the rkey deterministically from the Roomy message ULID, and use `com.atproto.repo.putRecord`, not `createRecord`.
- **A ULID is not a valid TID and cannot be used directly.** A ULID is 26 chars of Crockford base32 (uppercase, includes `0`, `1`, `9`); a TID is 13 chars from the alphabet `234567abcdefghijklmnopqrstuvwxyz`, with no `0`/`1`/`9` (verified against `@atproto/syntax`'s `ensureValidTid`, which enforces `TID_LENGTH = 13` and that alphabet, and by generating a sample TID). Encode the ULID's 48-bit timestamp and 80 bits of randomness into the TID alphabet — the derivation must be **total, deterministic, and collision-free**: two Roomy messages must never collide on a TID, or the second silently overwrites the first. Validation lives in the ATProto stack, not in this repo: `git grep -n "ensureValidTid\|ensureValidRecordKey" origin/next -- 'packages/**'` returns nothing, while the dev PDS's bundled `@atproto/syntax` defines `ensureValidTid` (13 chars, the alphabet above). [INFERENCE] that validator is what rejects a bad rkey at write time, so a malformed derivation surfaces as a PDS error rather than a silent mis-write — but the plan should not rely on it for collision safety.

With belt 2, the failure mode of "network call succeeded, process died before the mapping row was written" degrades from *duplicate post* to *harmless re-upsert*. With belt 1, the failure mode of "process died before the network call" degrades to *retry*. Together, the publish becomes safely retryable, which is the only reason automatic mirroring is defensible.

### 3.3 The replay problem: TASK-151's shape, and why publish needs more than the push fix

**The incident.** `packages/appserver/docs/push-freshness-gate.md` records it: the Discord bridge's `runBackfill` replays entire channel history through the **live** `sendEvents` path (`packages/discord-bridge/src/services/backfill.ts:104-120`, which says so in a comment), and every replayed message produced a push because the only time value in the pipeline was `decodeTime(event.id)` — the event ULID, which is *fresh at replay time*. The exact line: `packages/appserver/src/streams/StreamManager.ts:323` (`timestamp: decodeTime(e.id)`), documented as the defect at `packages/appserver/src/push/types.ts:25-36`.

**Why the push fix does not carry over.** Push was saved by an **age gate**: `isPushFresh` (`packages/appserver/src/push/freshness.ts:74-90`) with a 5-minute window (`:48`), applied at the enqueue site using the canonical timestamp (`StreamManager.ts:303-317`). The gate is right for push because push is a *transient* signal — dropping a stale one loses nothing. **Publish is the opposite**: the message's age is irrelevant to whether it *should* exist on Bluesky. A gate tuned to "only publish things younger than 5 minutes" makes historical share-by-hand impossible and makes a legitimate catch-up after downtime publish nothing. So publish cannot use an age gate as its *correctness* mechanism.

**Which replay paths can fire a publish hook?**

| Entry point | Evidence | Replays old events? | Verdict |
|---|---|---|---|
| `space.roomy.space.sendEvents` → `StreamManager.sendEvents` | handler at `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:176`; hard-codes `isBackfill: false` for `applyBatch` (`packages/appserver/src/streams/StreamManager.ts:244-246`) | **Yes** — the bridge's `runBackfill` is indistinguishable from live traffic; there is no replay marker on this path at all (called out as a follow-up at `push-freshness-gate.md:224-228`) | **A hook here fires on replay.** This is TASK-151. |
| Boot re-materialisation | `reMaterializeFromLocalEvents` (`packages/appserver/src/streams/reMaterialize.ts:60`), started fire-and-forget at `packages/appserver/src/index.ts:76`, applying with `isBackfill: true` (`reMaterialize.ts:263-265`) | **Yes, always after a schema wipe or blue-green rebuild** (`:9-12`; full rebuild from `idx 0` at `:122`) | A hook inside `applyBatch`/`applyBundle` fires on every boot after a wipe. |
| Sync `#streamEvents` backfill | `packages/appserver/src/sync/handler.ts:797-815` (`hasMore` at `:810`); resumable from a cursor | Yes (`cursor: -1` ⇒ full history) | Consumer-side only; this is how the bridge *re-sees* history, not how the appserver side-effects. |
| Jetstream / firehose | **Absent from the appserver** (it exists only as HappyView, an external Rust AppView) | n/a | No hook to place. |

**The design rule that follows.** Do **not** attach the publish side effect to any materialisation path. The repo already models the correct alternative: the embed sweeper. Its work queue is a **persisted table** (`pending_links`, `packages/appserver/src/db/schema-global.sql:86-93`), drained by a process-wide background loop (`packages/appserver/src/embed/sweeper.ts:53-55` — `SWEEP_BATCH = 25`, `IDLE_POLL_MS = 30_000`), whose enqueue is a plain `insert or ignore` and therefore idempotent across re-materialisation (`packages/appserver/src/materialization/applyBatch.ts:579-587`, with that rationale in the comment). Note that boot re-materialisation *pokes nothing* — `grep -n "poke\|onEventsApplied\|streamListeners" packages/appserver/src/streams/reMaterialize.ts` returns nothing — which is a second, independent reason a replay does not fire side effects today.

Publishing should be:

1. **Enqueued** into a persisted, idempotent work queue (`insert or ignore`, keyed by message), from exactly two places: a human action (A, which ignores age entirely — a historical message is exactly what a human shares by hand), or the live write path gated on the room's mirror toggle **and** the message being newer than the room's `mirror_from` watermark (B). Note the distinction: for the *auto* path a recency test is a scope decision (*"mirror the conversation from now on"*), not the correctness mechanism — the watermark and the mapping table are what make the replay safe. Removing the recency test from the auto path changes how much history it mirrors; removing the watermark or the mapping would change whether it double-posts.
2. **Drained** by its own sweeper with the embed sweeper's outcome model — `ok | definitive | transient` (`packages/appserver/src/embed/enricher.ts:75-79`), the escalating backoff at `:221-225` (1m / 5m / 30m / 2h, capped 6h), and the delete-on-settle rule that removes rows for `ok` **and** `definitive` so a permanently-failing item cannot stall the queue (`packages/appserver/src/embed/sweeper.ts:392-406`). A `definitive` outcome here means "this will never be publishable" — over the grapheme limit, no resolvable steward, a card with no title/description — and it must settle, or the queue never drains.
3. **Guarded by a first-run watermark**, not only by the mapping table. The global DB already has this shape twice: `search_backfill_cursor (space_did, cursor, updated_at)` (`schema-global.sql:119-123`) and the bridge's `space_cursors (space_did, last_idx)` (`packages/discord-bridge/src/db/schema.ts:116-120`, written with `ON CONFLICT DO UPDATE` at `repository.ts:482-490`). A per-room `mirror_from` watermark makes "enable mirroring on a room with 40 000 historical messages" a bounded operation instead of a 40 000-post incident. **The bridge's migration v2 comment is the transferable lesson**: cursors keyed by channel alone meant "connecting a channel to a second Roomy space inherited the first space's cursor and silently skipped backfill" (`schema.ts:68-71`) — the publish watermark must be keyed by `(space_did, room_id, target)`, not by room alone.

### 3.4 Edit and delete: what actually happens today

**Edit mutates in place; there is no version row and no tombstone.** `space.roomy.message.editMessage.v0` (`packages/sdk/src/schema/events/message.ts:183`) runs `update comp_content set mime_type = …, data = …, last_edit = <editEventId> where entity = <messageId>` (`:216-233`). There is deliberately **no** entity row for the edit event (`:204-211`). `comp_content.last_edit` holds the most recent edit event's ULID, and on an unedited message the materialiser stamps it with the *creating* event's id — so `lastEdit` is surfaced to clients only when it differs from the message id (`packages/appserver/src/queries/selectMessages.ts:504-508`).

- **Consequence for publishing:** "has this message changed since we published it?" is answerable **without any new state** — store the `last_edit` value observed at publish time as `published_revision`, and re-publish when the current `last_edit` differs. Because §3.2 chose a deterministic rkey with `putRecord`, an edit is an **upsert of the same post**, not a second post. That is a genuinely clean story, and it is only available because of the belt-2 decision.
- **A subtlety:** the "unedited" encoding is `last_edit == message_id`, so `published_revision` must be compared against `last_edit` as-is, not against the client-facing `lastEdit` field (which is `undefined` for unedited messages — `selectMessages.ts:506-508`). Comparing against the DTO field would read "unedited" and "revised" as the same value.
- **The invalidation signal already keys on the message, not the edit event** (`packages/appserver/src/invalidation/inferSignals.ts:445-449`, ops at `:466` keyed by `messageId`) — the same convention applies to a publish refresh.

**Delete removes everything, including the evidence that the message existed.** `space.roomy.message.deleteMessage.v0` (`message.ts:400`) issues `delete from entities where id = <messageId>` (`:429`); `comp_content` cascades (`packages/appserver/src/db/schema-space.sql:119-120`, `on delete cascade`). After the delete there is **no row in the per-space DB** recording the message id, let alone that it was published.

- **Consequence:** the retraction signal must come from the mapping table in the **global** DB, which the per-space cascade does not touch. This is a second, independent reason the mapping table cannot live in the per-space DB.
- **Retraction mechanism:** `com.atproto.repo.deleteRecord` via the arbiter proxy. `ProxyOperation` already supports `"DELETE"` (`packages/sdk/src/atproto/arbiter.ts:30`), so no SDK change is needed. The alternative — overwriting the post with a tombstone via `putRecord` — is what some Bluesky clients do, but it is not required here.
- **Prior art, in-repo:** the bridge's outbound delete path resolves the external id from the mapping and then deletes: `getDiscordId(spaceDid, "message", event.messageId)` at `packages/discord-bridge/src/services/roomy-event-router.ts:742-746`, delete at `:760-765`, followed by `unregisterMapping` (`:766`).
- **Do not copy the bridge's `unregisterMapping`.** For Bluesky, keep the row with a `deleted_at` / `state = 'deleted'` marker. The bridge removes the row on outbound delete and (deliberately, by a different code path) keeps it on inbound delete (`packages/discord-bridge/src/services/message-edit-delete.ts:221` — "Keep mapping row — delete is recorded; future edit attempts skip naturally"). The publish path should keep it in **both** directions, because a delete event can be delivered more than once (at-least-once delivery is the bridge's own documented model — `packages/discord-bridge/src/roomy/live-gateway.ts:271-279`) and a removed row turns the second delivery into a no-op-with-no-record rather than a confirmed already-handled state.
- **Delete is authoritative and irreversible on Bluesky.** Once retracted, a re-publish would need a new post; the plan should treat "delete then re-share" as a new publish, not a resurrection.

### 3.5 The failure-mode summary

| Scenario | Required behaviour |
|---|---|
| Bridge replays 5 000 historical messages | **Zero posts.** The mapping table (and, on the auto path, the `mirror_from` watermark) — never an age gate, per §3.3. |
| Publish call times out after the PDS accepted it | **One post.** Deterministic rkey + `putRecord` makes the retry an upsert. |
| Process dies between the send and the mapping write | **One post.** Same mechanism. |
| Message edited after publishing | **One post, updated.** `last_edit != published_revision` ⇒ `putRecord` on the same rkey. |
| Message deleted after publishing | **Post removed.** Mapping row retained with a `deleted` marker; `deleteRecord`. |
| Delete event replayed | **No-op.** The retained marker makes the second delivery recognisable as already handled. |
| Message over 300 graphemes, mirroring on | **No post, terminal.** `definitive` outcome; the row settles rather than retrying forever (the embed sweeper's own rationale at `enricher.ts:66-75`: retrying forever "left a permanent backlog and a permanent log flood"). |
| Space has no arbiter | **No post, terminal, visible.** Steward resolution throws (`arbiter.ts:125-127`); do not retry indefinitely. |
| Arbiter policy denies the write | **No post, terminal, surfaced.** `ArbiterProxyError` carries the upstream error name (`packages/sdk/src/atproto/arbiter.ts:186-206`), and the app-lite handle path already maps error names to human messages (`packages/app-lite/src/lib/mutations/space-handle.ts:33-46`) — the same pattern applies. |

---

## 4. Policy implications

### 4.1 Who is accountable

**The space's posts are published under the space's stewarded ATProto account.** Three facts compose:

- The space's DID *is* a real PDS account, provisioned by the arbiter (`packages/appserver/src/arbiter/provision.ts:46-56`).
- The arbiter holds that account's **PDS password** (`packages/appserver/docs/plans/arbiter-integration.md:47-52`) and is a policy proxy, not a key custodian.
- The **appserver DID is the recovery admin of every stewarded account** — stated in the provisioning comment (`provision.ts:53-55`) and resolved as a question in the arbiter plan (`arbiter-integration.md:299-306`).

So there are two accountable parties, and they are not the same:

- **The space's admins**, who can act under the account through the arbiter's policy (the policy is what grants them; §4.2).
- **Roomy (the appserver DID)**, which can *always* act, because it is the recovery admin. A compromise or a bug in the appserver is, by construction, able to post as any space.

That second fact is worth stating plainly, because it is the answer to "who is accountable": for a policy-violating post, the space's admins are the visible actor, and Roomy is the actor with unconditional capability. Members may be surprised by the latter.

**Moderation and abuse: there is no story in the repo, and it cannot be invented here.** Concretely, the gaps:

- **A Roomy admin deleting a Roomy message does not retract the Bluesky post** unless the publish path is built to do so (§3.4); and once retracted, the post may already have been indexed, quoted, or reposted by the network.
- **Bluesky-side moderation is outside Roomy.** Labels, blocks, takedown requests, and reports all happen in the Bluesky ecosystem against the space's account. There is no integration point for any of it in this repo.
- **Rate limits and content rules apply to the space's PDS account,** so one spammy member can degrade the *space's* standing, not just their own.
- **Banning a member in Roomy does not remove what they already posted** in this space's name, and — if auto-mirroring is on — a banned user's next message is blocked at write time by the existing ban check on the write path (`packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:108-112`) rather than at publish time, which is the correct layering but worth stating.

### 4.2 What the arbiter's policy would need to permit

**The policy is not in this repo.** Verified: the only `town.muni.arbiter.policy` occurrence in code is the AT-URI *string* at `packages/appserver/src/arbiter/provision.ts:35` — `at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default` — and a repo-wide grep for `.rego` files or `package arbiter` outside `arbiter-integration.md` returns nothing. The policy is a document in someone else's repo, fetched and hot-reloaded by the arbiter (`arbiter-integration.md:67-77`).

What *is* in the repo:

- The appserver's three arbiter calls: `createArbiter` (`packages/appserver/src/arbiter/client.ts:98`), `resetConfig` (`:118`), `proxy` (`:136`). It never calls `resetPolicy`.
- The reference config applied at provisioning (`provision.ts:30-36`): `trustedScopes: ["space.roomy.authComplete"]` and the single `policyLayers` AT-URI above.
- The policy's data hook back into Roomy: **`space.roomy.space.getUserAccess`** (`packages/appserver/src/handlers/space.roomy.space.getUserAccess.ts:38-70`), whose authorization is `auth.did !== null && auth.did === spaceId` (`:46`) — i.e. it only answers when the caller *is* the space DID, which is true only when the arbiter is proxying under the stewarded account. Its header (`:5-23`) explains why that is the correct boundary and why it fails closed. [Note: this endpoint is the *shipped* equivalent of `space.roomy.space.isAdmin`, which `arbiter-integration.md:174-235` proposes as not-yet-implemented. The arbiter plan's Phase 2 description is out of date on this point.]

**The two publish paths present two different callers to the policy, and this is the decision that matters:**

- **Client-driven (A):** app-lite mints a serviceAuth token to the arbiter with the *user's* agent (`packages/sdk/src/atproto/arbiter.ts:140-150`), so `input.callerDid` is the human admin — an identity the policy already has a way to evaluate, via the `xrpc()` host function calling `getUserAccess` (`arbiter-integration.md:73-76`, `:198-210`). The OAuth scope for this is already granted (`packages/app-lite/src/lib/config.ts:125-135`, mirrored at `packages/app-lite/scripts/build-prod.sh:34-40`).
- **Server-driven (B):** the appserver calls `proxy()` as **itself** — `mintServiceAuth(config.did, nsid, ownDid)` signs with the appserver's key and sets `iss = sub = ownDid` (`packages/appserver/src/auth/serviceAuth.ts:110-135`). The appserver **cannot** assert a space DID; it has no space keys (the legacy path's `did_keys` table is only written by the non-arbiter provisioning branch — `packages/appserver/src/streams/StreamManager.ts:371-376`). The arbiter plan's Phase 2 sketch grants `input.callerDid == input.arbiterDid` (the space itself) and Roomy *admins* — **not the appserver DID** (`arbiter-integration.md:174-210`).

**So: enabling automatic mirroring requires a change to a document outside this repo** (plus, if the reference config should change, a `REFERENCE_ARBITER_CONFIG` edit at `provision.ts:30-36` and a re-apply to existing spaces). Re-application is available via the admin-only `space.roomy.space.updatePolicy` procedure, which calls `resetConfig` with the reference config (`packages/appserver/src/handlers/space.roomy.space.updatePolicy.ts:65`). Note two stale/incorrect pointers found while verifying:

- `provision.ts:25-28` says the constant "Must stay in sync with `scripts/migrate-arbiter-configs.ts`" — **that script does not exist** (`packages/appserver/scripts/` contains `bench-materialize.ts`, `bench-queries.ts`, `generate-vapid.ts`, `migrate-from-leaf.ts`, `migrate-spaces-to-pds.ts`, `repair-activity-timestamps.ts`). The re-apply mechanism is the `updatePolicy` procedure.
- `packages/sdk/src/schemas/procedures/updatePolicy.ts:5-8` says the appserver calls `town.muni.arbiter.resetPolicy`; the implementation calls `resetConfig` (`packages/appserver/src/arbiter/client.ts:118-129`).

Neither is caused by this work, and neither blocks it, but the second one will mislead whoever writes the policy change.

### 4.3 Policy questions this plan will not answer

See §6. Summarising the shape: **client-driven publishing is the only path whose authorization is already expressible today**, because its caller is a human admin the policy can check. Server-driven publishing makes the accountable actor the appserver's DID, i.e. Roomy-the-operator, on behalf of spaces that merely flipped a toggle. That is a decision about what Roomy is willing to be, not a technical one.

---

## 5. Phases

Each phase states an **observable completion criterion**. Nothing here is implemented yet; §0.2 gives the greps proving the publish half is absent.

### Phase 0 — Decisions (this document; no code)

**Completion criterion:** the open questions in §6 have answers in this document, recorded as decisions.

---

### Phase 1 — Per-space opt-in, default closed

**Deliverables**

- New SDK event (`space.roomy.space.setPublishTarget.v0`, or the `updateSpaceInfo` `.v1` variant — §1.2) + materialiser writing a new `comp_space.publish_enabled` column.
- The three mandatory registrations: `registry.ts`, `writeAuth.ts` `ALLOWED_TYPES` **and** `SPACE_MANAGE_TYPES`, `invalidation/inferSignals.ts`.
- `comp_space.publish_enabled` added to `schema-space.sql` with a `SPACE_SCHEMA_VERSION` bump (`packages/appserver/src/db/db.ts:31`).
- `getMetadata` returns `publishEnabled: boolean` (`coalesce(publish_enabled, 0)`), alongside the existing `isAdmin` (`packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:343`).
- The integrations tab shows the toggle for `space-account-management` **AND** `isAdmin` (the existing `showIntegrationsTab` precedent, `packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:159-161`).

**Observable completion criterion**

- A test shows a space with **no** opt-in event reads `publishEnabled === false`, and that the value is **still false after a simulated `SPACE_SCHEMA_VERSION` bump + re-materialisation** (this is the test that proves the event-sourced choice was correct).
- A test shows a non-admin caller's `setPublishTarget` event is rejected by `checkWriteAuth`.
- A test shows that setting the opt-in to true and then false round-trips through `getMetadata`.

---

### Phase 2 — The exporter and the mapping table (no network)

**Deliverables**

- A **pure** `roomyMessageToBskyPost(message) → { text, facets, createdAt } | { skipped: reason }` in the SDK, implementing §2.3–§2.5. No I/O.
- The `(space_did, message_id) → (rkey, post_uri, post_cid, published_revision, state, attempts, retry_after)` table in `schema-global.sql` + a `GLOBAL_MIGRATIONS` `structural` entry (`packages/appserver/src/db/globalVersions.ts:51-74`).
- The deterministic ULID→TID rkey derivation (§3.2), with its own collision test.

**Observable completion criterion**

- The exporter round-trips a corpus — plain text, `#link`, `#didMention`, bold/italic, internal links, code blocks, ordered/unordered lists, emoji — with **every emitted facet's byte range slicing the emitted text to exactly the annotated substring** (assert by slicing the UTF-8 bytes, not the JS string).
- A message whose only facet is `#roomRef` emits **zero** facets, and one with `#link` + `#roomRef` on one range emits exactly one.
- A 301-grapheme message returns `skipped: "too_long"`; a 300-grapheme message does not.
- The rkey derivation is stable (same ULID → same TID) and does not collide across a large sample of ULIDs.

---

### Phase 3 — Manual share (the first end-to-end publish)

**Deliverables**

- An admin-only "Share to Bluesky" action on a message, client-driven through the arbiter (`ArbiterClient.proxy`, `packages/sdk/src/atproto/arbiter.ts:156`) — the same mechanism the handle and profile writes already use.
- Publish writes via `com.atproto.repo.putRecord` with the derived rkey; the returned `uri`/`cid` are recorded in the mapping table.
- A retraction (delete) path exercising §3.4.
- The `space.roomy.space.updatePolicy`-style error surfacing: map `ArbiterProxyError.errorName` to a human message.

**Observable completion criterion**

- An admin shares one message; the post exists at the recorded `uri` and its text matches the exporter's output.
- Sharing the **same message a second time creates no second post** (the same `uri` is returned) — the belt-2 property, proven by observing a single record at that rkey.
- Deleting the Roomy message removes the Bluesky record; replaying the delete event does not error and does not re-attempt.
- A space with `publishEnabled === false` cannot reach the action at all.

---

### Phase 4 — Automatic mirroring (per-room, opt-in)

**Deliverables**

- A per-room mirror toggle, off by default even when the space opt-in is on.
- A persisted work queue + a sweeper modelled on `packages/appserver/src/embed/sweeper.ts` (batched, idle-polled, `ok | definitive | transient` outcomes, escalating backoff, delete-on-settle).
- Enqueue from the live write path only, gated on the room toggle; **never** from `applyBatch`/`applyBundle`.
- A per-room `mirror_from` watermark, keyed `(space_did, room_id, target)`.

**Observable completion criterion**

- Enabling mirroring on a room with pre-existing history publishes **zero** historical messages, and a message posted afterwards publishes **exactly one**.
- A simulated bridge-style replay of N historical `createMessage` events through `sendEvents` produces **zero** posts (the TASK-151 shape, asserted directly).
- A simulated `SPACE_SCHEMA_VERSION` bump + full re-materialisation produces **zero** new posts (the rebuild path, asserted directly).
- A permanently-failing message (over the limit, no steward) settles to a terminal state and leaves the queue (the sweeper still drains to newer work on the next cycle).
- A transient PDS failure retries and eventually succeeds, producing exactly one post.

---

### Not in scope (explicit)

- **Media embeds** (images, video) — the blob-transfer and permission questions of §2.6, and open question §6.3.
- **Link-card thumbnails** — cards publish with `uri`/`title`/`description` only; thumbnails need blob upload.
- **Reply threading and quote posts** — need the mapping table to be mature first (§2.6).
- **`langs`** — no language detection exists to base it on.
- **Bluesky-side moderation tooling** (labels, reports, blocks) — outside this repo (§4.1).
- **Publishing from a space without an arbiter** — the legacy did:plc path (`packages/appserver/src/streams/did.ts:21`) has no PDS account and no credentials; it is out of scope by construction, pending `arbiter-integration.md` Phase 4.
- **Thread-splitting long messages** (§2.5).
- **A capability model** finer than admin (§1.4, §6.2).

---

## 6. Open questions for Meri

These are decisions, not gaps in research. Each names the options and the tradeoff; none is invented into a default.

**6.1 May the appserver publish without a human in the loop?** This decides whether automatic mirroring (Phase 4) is possible at all. Server-driven publishing requires the arbiter's Rego policy — a document outside this repo (§4.2) — to permit `com.atproto.repo.putRecord` for the **appserver's own DID**, and it makes Roomy-the-operator the accountable actor for any space that flips a toggle. Options: (a) client-driven only, admins publish by hand; (b) allow the appserver DID and accept operator accountability; (c) allow the appserver DID but only for rooms whose admins have explicitly accepted that. **The plan is written so that Phase 3 is deliverable under (a) alone.**

**6.2 Who may share a message to the space's Bluesky account?** Admin-only (matching every other space setting, §1.4) or any member? Any-member publishing under a shared identity is a reputational exposure that admin-only avoids; a capability model to express anything in between does not exist today and would be new work.

**6.3 May a space re-host a member's media under the space's identity?** Roomy attachments are blobs on the *author's* PDS; publishing them under the *space's* account means copying a user's file into another repo (§2.6). This is a consent question about members' content, not a technical one.

**6.4 What happens to a space with no stewarded account?** Steward resolution fails opaquely today — `getSpaceProfileRecord` swallows every error and returns `null` (`packages/sdk/src/atproto/bluesky-profile.ts:83-86`), so "no steward" and "no profile" are indistinguishable in the UI. Options: (a) surface steward state in `getMetadata` (needs a new read, since no appserver table records it); (b) stop swallowing the error so the integrations tab can say *why*; (c) leave it. The plan needs the answer before Phase 1's UI work, because offering a publish toggle on a space that cannot publish is a dead control.

**6.5 What is the character-limit policy?** Refuse (recommended, §2.5), truncate, or split into a thread. If "refuse", what does the sharer see — and does an auto-mirrored room silently drop long messages, or notify its admins?

**6.6 What is the retraction promise?** When a Roomy admin deletes a message, does Roomy guarantee the Bluesky post is removed (best-effort, with a visible failure), or only attempt it? Deleting a message in Roomy currently removes it permanently and locally (`packages/sdk/src/schema/events/message.ts:429`); a partial publish failure leaves the two out of sync, and the plan needs to say what the user is told.

---

## 7. References

**In-repo (all verified on `origin/next` @ `c7087ea9`)**

- `packages/appserver/docs/plans/arbiter-integration.md` — the arbiter (leaf-0.4) integration plan. Phases 0–1 shipped; 2–4 not implemented. This plan is a new phase consuming that machinery. (Note: its Phase 2 claim that `space.roomy.space.isAdmin` does not exist is stale — the shipped equivalent is `space.roomy.space.getUserAccess`, and its Phase 3 "not needed yet" note is what this plan begins to change.)
- `docs/plans/richtext-migration-plan.md:160` — the export mapping, already researched (§0.3).
- `docs/rich-text-representation-research.md:136-183` — the Bluesky post/facet lexicon analysis, and the byte-index footgun.
- `packages/appserver/docs/push-freshness-gate.md` — the TASK-151 incident write-up (mechanism, evidence, mitigations, and the replay-marker follow-up at `:224-228`).
- `packages/appserver/docs/plans/per-space-dbs.md` — per-space DB split, and `comp_space.backfilled_to`'s move to `materialization_cursor`.
- `packages/docs/src/routes/concepts/feature-flags/+page.svelte` — the authoritative flag semantics ("not a security boundary", "not per-space").

**External (fetched 2026-09-16; not in this repo)**

- `lexicons/app/bsky/feed/post.json` — required `text` + `createdAt`; `text` `maxLength 3000` / `maxGraphemes 300`; `key: "tid"`; the `embed` union.
- `lexicons/app/bsky/richtext/facet.json` — `#byteSlice` (UTF-8, start inclusive / end exclusive) and the closed `mention | link | tag` feature union. The `byteSlice` description explicitly warns UTF-16 languages to convert to byte arrays, which is the constraint `packages/sdk/src/richtext/convert.ts:22-25` already encodes.
- `lexicons/app/bsky/embed/external.json` — `uri` / `title` / `description` required, `thumb` a ≤1 MB blob.
- `lexicons/app/bsky/embed/images.json` — ≤4 images, ≤2 MB each, `alt` required.

---

## 8. Verification notes

- Every `file:line` in this document was read from `origin/next` at `c7087ea9`; the working tree was clean and at that commit throughout.
- The absence of the publish half was verified with the greps quoted verbatim in §0.2, each runnable as written against `origin/next`.
- Runtime facts checked rather than assumed: `Intl.Segmenter` grapheme segmentation (family emoji → 1 grapheme; `e` + combining acute → 1; vs 7 and 2 code points) and the TID alphabet/length (13 chars from `234567abcdefghijklmnopqrstuvwxyz`; a ULID is 26 Crockford base32 chars including `0`, `1`, `9`, so it is **not** a valid TID).
- No production code was changed by this task.
