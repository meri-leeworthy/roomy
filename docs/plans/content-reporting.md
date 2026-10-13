# Reporting objectionable content — Implementation Plan

**Date:** 2026-10-13
**Status:** Planned. Not started. §9 is a decision record; the transport decision
(§3) is settled and the phasing (§7) is not yet dispatched.
**Next:** Phase 1 (§7) — the message toolbar's Report action, the confirm
dialog, the appserver procedure and the space-settings queue. It is the smallest
slice that answers App Store Guideline 1.2's reporting clause (§8) and it ships
on its own.
**Verified against:** `origin/next` @ `2e912191`. Every `file:line` below was read
at that commit.
**Packages:** `packages/app-lite`, `packages/design`, `packages/appserver`,
`packages/sdk`, `packages/docs`.

**Path choice.** This document lives at `docs/plans/content-reporting.md`. The
root `docs/plans/` directory holds the cross-package plans
(`bluesky-publishing.md`, `web-tiles-integration.md`, `voice-chat-plan.md`);
this work touches a design-system component, an app-lite route, three appserver
handlers, an SDK schema and the docs endpoint catalogue — five packages, so the
root directory is correct.

**Relation to the blocking work.** Reporting and blocking are the two halves of
the same requirement, and they are planned separately because they are different
mechanisms with different transports. `packages/app-lite/docs/plans/user-blocks.md`
("user-blocks") is the blocking half. That plan is about *hiding*: a per-viewer
read-path redaction of an author's content. This plan is about *telling an
admin*, which has no read-path component at all. The two share exactly one
thing — the word "moderation" and the `isAdmin(db, spaceId, did)` predicate they
both gate on — and §5.5 states where they meet and where they must not.

---

## 0. What this document is

A plan for a user-facing **report** flow: a way for a Roomy user to flag a
message they find objectionable so that a space's moderators see it and can act.
Three things are decided here and everything else follows from them:

1. **The transport is a Roomy-owned queue in the appserver's read-state DB, not
   an ATProto moderation service and not a space-stream event** (§3). The
   tradeoff is stated in full, because two of the three options are defensible
   and the wrong choice is expensive to undo.
2. **A message is not an atproto record**, so `com.atproto.moderation.createReport`
   — the protocol's own report method — cannot currently name one as its
   subject. That fact, and not a preference, is what decides (1).
3. **The queue belongs to space admins, in app-lite's space settings**, not to
   the service-operator dashboard in `packages/docs` (§6.4). The two "admin"
   notions in this tree are unrelated and §5.5 restates that where a report
   handler could get it wrong.

The document is in four parts after the starting point: the transport (§3), the
record and its read/write path (§4–§5), the UI (§6), and then the phasing (§7)
and the App Store mapping (§8) that say what "done" means for review.

---

## 1. Goal

A Roomy user can report a message. The report reaches the space's moderators,
who can read the reported message, dismiss the report, or remove the content and
the author. The reporter is not exposed to the reported user. Nothing about a
report is visible to an ordinary member of the space.

Concretely, that is:

- **A report affordance on a message** — the toolbar's "…" menu, beside Edit,
  Forward, Move and Delete.
- **A confirm step** — a reason and an optional note, so the queue is actionable
  and an admin is not left guessing what the reporter found objectionable.
- **A private record** — readable by the space's admins, by nobody else.
- **A moderation queue** — the space-settings surface where an admin reads the
  reported content and resolves it.
- **A resolution that writes the durable outcome as an event** — a ban already
  is one (`space.roomy.space.banAccount.v0`), and removal already exists as
  admin delete (§2.1).

What is deliberately **not** in v1, and why, is §9.1 (auto-hiding on report) and
§8.2 (the "filtering" clause of the same guideline).

---

## 2. Verified starting point

Everything in this section is a fact about `origin/next` @ `2e912191`, with the
file and line that establishes it.

### 2.1 The only moderation primitive is a space-scoped ban

Moderation in this tree is **event-sourced**: a moderation action is an event
written to the space's stream, authorized per-event on the write path, and
materialised into a per-space table. The ban is the whole of it.

| Piece | Where |
|---|---|
| `comp_bans` table + index | `packages/appserver/src/db/schema-space.sql:310-318` — `(entity, user_did, created_at)`, PK `(entity, user_did)` |
| Event schema + materialiser | `packages/sdk/src/schema/events/space.ts:299-314` (`BanAccount`), `:316-333` (`UnbanAccount`) |
| Event registry entries | `packages/sdk/src/schema/events/registry.ts:90-91` |
| Event-variant union | `packages/sdk/src/schema/events/space.ts:420-431` |
| Write authorization | `packages/appserver/src/auth/writeAuth.ts:168-186` (`SPACE_MANAGE_TYPES`, ban at `:175`), dispatched at `:937-939` to `requireSpaceAdminCheck` (`:348-360`) |
| Send path | `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:157-181` (per-event `checkWriteAuth` loop), `:207` (write) |
| Invalidation | `packages/appserver/src/invalidation/inferSignals.ts:977-996` (`handleBanAccount`, `handleUnbanAccount`), registered at `:1340-1341` |
| Admin predicate | `packages/appserver/src/auth/access.ts:124-131` (`isAdmin`), `:191-195` (`queryIsBanned`) |
| Roster projection | `packages/appserver/src/queries/members.ts:88-102` — `is_admin` / `is_banned` as `exists` subqueries |
| UI | `packages/app-lite/src/routes/[space]/settings/members/+page.svelte:77-110` (`banMember`, `unbanMember`), `:151-180` (the menu items) |

Two properties of the ban matter here and are easy to get wrong:

- **A ban does not hide existing content.** `comp_bans` has exactly three
  consumers outside tests, and none of them is a content read:
  `spaceAccess`'s `queryIsBanned`
  (`packages/appserver/src/auth/access.ts:191-195`, which feeds the *write*
  path and the delivery-time re-checks), the roster projection
  (`packages/appserver/src/queries/members.ts:97`), and
  `selectJoinedSpaces`'s per-space membership probe
  (`packages/appserver/src/queries/joinedSpaces.ts:120-131`, which drops a
  banned space from the caller's own list). There is no ban predicate in
  `selectMessages`, and no ban filter on any message-carrying read route. A
  banned account's messages keep rendering. Removing content and ejecting an
  author are therefore **two separate admin actions**, and both already exist:
  the ban, and admin delete
  (`packages/app-lite/src/lib/components/chat/ChatMessage.svelte:281` —
  `canDelete = isAuthor || isAdmin`; the dialog at
  `packages/design/src/components/content/thread/message/DeleteMessageDialog.svelte:23-25`
  carries the moderation case explicitly).
- **A ban is public.** It is an event in the space stream, and the stream is
  readable by every member (`packages/appserver/src/sync/handler.ts:437-449`,
  `#canReadStream` — membership or admin, banned denied). §3.2 turns on this.

So the tree already satisfies "remove content that violates this guideline" and
"eject the author" — as *admin actions with a UI*. What it does not have is a way
for a non-admin to *ask* an admin to act, which is the gap Guideline 1.2 names.

### 2.2 Nothing about reporting exists

Searched at `2e912191`, and every one of these is **absent**:

- **No record, no event, no table.** `createReport`, `reportContent`,
  `reportMessage`, `report.v0`, `abuse` and `moderation.createReport` return no
  matches across `packages/**/*.ts`, `*.svelte` and `*.json` (excluding
  `node_modules`, `dist`, and the `specs/traces` fixtures).
- **No lexicon.** `packages/appserver/lexicons/**/*.json` is ten files —
  `user/{profile,block,getProfile,getProfiles}.json`, `richtext/{blocks,document,facet}.json`,
  `mention/getMentions.json`, `embed/getLinkMetadata.json`, `service.json`. None
  is a report. `glob packages/**/*report*.json` finds nothing.
- **No XRPC route.** `packages/docs/src/lib/endpoints/nsids.generated.json`
  holds 72 NSIDs; the only `Other`-grouped one is
  `space.roomy.pro.createCheckout`, and none is a report or moderation endpoint.
- **No read-state table.** `packages/appserver/src/db/readStateSchema.sql`
  declares eighteen tables (`:13`–`:272`); none is a report.
- **No feature flag.** `packages/appserver/src/featureFlags.ts:21-66` registers
  nine flags (`search`, `space-account-management`, `pro-subscription`,
  `links-view`, `semble-integration`, `access-settings`, `user-blocks`,
  `voice-chat`, `bluesky-dms`). No report flag.
- **No UI string, no icon, no callback.** No `Report` / `Report message` /
  `Flag` action in `packages/design/src` or `packages/app-lite/src`; the only
  matches for "report" are a local diagnostic `function report(...)` in
  `packages/app-lite/src/lib/client.ts:130` and prose in comments. No
  `onReport` prop anywhere.
- **No labeler, no labels.** No `com.atproto.label.*` reference, no `#labeler`
  service record, no label record type.

The nearest existing user-facing safety affordance is the **block** on a profile
(`packages/app-lite/src/routes/user/[user]/+page.svelte:479-491`), which is the
other half of the same requirement and is being built separately.

### 2.3 A message is not an atproto record, and this is the load-bearing fact

A Roomy message has an **id**, and that id is a ULID — not an at-uri, and there
is no CID anywhere near it.

| Claim | Where |
|---|---|
| The wire shape is `{ id: string, ... }` — no `uri`, no `cid` | `packages/appserver/src/queries/selectMessages.ts:55-102` (`MessageDto`); the same shape in the SDK at `packages/sdk/src/schemas/queries/_message.ts:91-137` |
| Message bodies live in a blob column with no content address | `packages/appserver/src/db/schema-space.sql:153-161` (`comp_content`: `mime_type`, `data blob`, `last_edit`, `timestamp`) |
| The durable form is an event-log row, not a repo record | `packages/appserver/src/db/eventsSchema.sql:3-13` (`stream_events`), written by `packages/appserver/src/streams/StreamManager.ts:208` |
| Messages are addressed by ULID in the protocol itself | `packages/sdk/src/schema/events/message.ts:185` (`messageId: Ulid`), `:401` (`deleteMessage.messageId: Ulid`) |
| No `strongRef` / `{uri, cid}` anywhere | grep for `strongRef`/`strong_ref` across `packages/{appserver,sdk,app-lite}/src` returns nothing |

Nothing in the tree commits a message to a repository. The only repo writes are
the caller's own profile and blob records
(`packages/sdk/src/atproto/records.ts:40`, `:75`), the space's
`space.roomy.service/self` record
(`packages/appserver/scripts/migrate-spaces-to-pds.ts:189`), and the block record
(`packages/app-lite/src/lib/mutations/blocks.ts:35`). A message exists as an
event in the appserver's event log and as rows in the per-space DB.

This is why §3 rejects the protocol's own report method *for now* rather than
adapting it: the method's subject is a reference into a repository, and a Roomy
message is not in one.

### 2.4 The confirm/modal and toolbar conventions

The message toolbar is one file: `ToolbarShell.svelte` is both the emoji/reply/
forward button row and the "…" `ContextMenu` (`:161`) whose items are
`ContextMenuItem` blocks (`:175-219`). Its props are a flat destructured object
(`:22-63`) in which **an optional handler's presence is the eligibility rule** —
the pattern `onCreateCard?` (`:37`, `:61`) and `onSaveToCollection?` (`:40`, `:62`)
already establish, so there is no separate boolean gate to keep in step.

The app-lite side is a four-hop prop chain that mirrors one action exactly:

| Hop | File | Anchor |
|---|---|---|
| Route page owns the modal | `packages/app-lite/src/routes/[space]/[room]/+page.svelte` | `openDeleteConfirm` `:76-80`; `<ChatArea … onRequestDelete={openDeleteConfirm} />` `:419`/`:455`; `<DeleteMessageDialog …>` `:480-491` |
| `ChatArea` forwards per row | `packages/app-lite/src/lib/components/chat/ChatArea.svelte` | props `:27-44`; `isAdmin` `:53`; per-row pass-through `:525-539` |
| `ChatMessage` supplies the toolbar snippet | `packages/app-lite/src/lib/components/chat/ChatMessage.svelte` | props `:45-72`; `canDelete` `:281`; the snippet `:647-670` |
| `MessageToolbar` bridges to the design component | `packages/app-lite/src/lib/components/chat/MessageToolbar.svelte` | props `:7-28`; `<ToolbarShell …>` `:72-88` |

The confirm dialog is a design-system component built on `@foxui/core`'s
`Modal` and `packages/design`'s `Button`:
`packages/design/src/components/content/thread/message/DeleteMessageDialog.svelte`
(`import { Modal }` `:2`; props `:6-27`; `<Modal bind:open closeButton>` `:54`;
buttons `:84-92`). The lighter-weight convention — a bare `confirm()` — is used
only for admin writes that need no copy
(`packages/app-lite/src/routes/[space]/settings/members/+page.svelte:78`). A
report needs a reason and an optional note, so it takes the modal.

### 2.5 Where an admin surface lives, and the two admins

- **Space admins** are the per-space `admin` edge
  (`packages/appserver/src/auth/access.ts:124-131`, `queryIsAdmin` at `:169-176`),
  surfaced to clients as `isAdmin` on `space.roomy.space.getMetadata`
  (`packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:375`). Their
  UI is app-lite's space settings: tabs registered at
  `packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:197-210`
  (with per-tab gates like `showFederationTab` at `:190`), titles in the switch
  at `packages/app-lite/src/routes/[space]/settings/+layout.svelte:18-44`, and an
  admin-gated page to model on — `packages/app-lite/src/routes/[space]/settings/federations/+page.svelte:1-35`
  (`isAdmin` from space metadata, four queries with `enabled: () => isAdmin`).
- **Service operators** are a *different* set entirely: the `APPSERVER_ADMIN_DIDS`
  allowlist (`packages/appserver/src/admin.ts:40-51`), which gates the
  `space.roomy.admin.*` handlers and `space.roomy.sync.getEvents`
  (`packages/appserver/src/handlers/space.roomy.sync.getEvents.ts:13`, `:32`).
  Its UI is the client-only dashboard in `packages/docs`
  (`packages/docs/src/routes/dashboard/+page.svelte:220-230` is the "Admins Only"
  gate; `packages/docs/src/lib/auth.svelte.ts:42-44` is the UI-only `isAdmin`;
  `packages/docs/src/lib/config.ts:9-15` reads `PUBLIC_APPSERVER_ADMIN_DIDS`).

The user-blocks plan already records that these two must never be confused
(`packages/app-lite/docs/plans/user-blocks.md`, §3.6/§7.15, and `admin.ts:39-51`).
§5.5 and §6.4 do the same here, because a report queue is the kind of feature
that invites the mistake.

### 2.6 The protocol shape, for reference

`com.atproto.moderation.createReport` (fetched from `bluesky-social/atproto`,
2026-10-13) is a **procedure** — "Submit a moderation report regarding an
atproto account or record. Implemented by moderation services (with PDS
proxying), and requires auth." Its input is:

```json
{ "reasonType": { "$ref": "com.atproto.moderation.defs#reasonType" },
  "reason":     { "type": "string" },
  "subject":    { "type": "union", "refs": [
                    "com.atproto.admin.defs#repoRef",
                    "com.atproto.repo.strongRef" ] },
  "modTool":    { "$ref": "#modTool" } }
```

Its output is `{ id, reasonType, reason?, subject, reportedBy, createdAt }`. The
`reasonType` vocabulary is `com.atproto.moderation.defs`: `reasonSpam`,
`reasonViolation`, `reasonMisleading`, `reasonSexual`, `reasonRude`,
`reasonOther`, `reasonAppeal`, plus the newer `tools.ozone.report.defs#reason*`
tokens.

Two things about this lexicon drive §3:

- **`subject` is a repository reference** — either a bare repo DID or a
  `strongRef` (`{uri, cid}`). §2.3 establishes that a Roomy message has neither.
- **The method is implemented by the moderation service, not the client.** A
  report is delivered by proxying the call to a service that can then *resolve*
  the subject. Ozone, the reference implementation, resolves a message subject
  with `com.atproto.repo.getRecord`. Against a Roomy message id that resolves to
  nothing.

The tree's own forward-looking note on this agrees on the shape to aim for —
`docs/open-social-proposal-8-oct.md:60-66` describes community moderation as
"reports come in one side, labels come out the other side", with `createReport`
as the inbound method and a label record as the outbound one — and confirms none
of it exists here yet.

---

## 3. The transport decision

### 3.1 The three candidates

| | Where a report lives | Who can read it | Who can act on it |
|---|---|---|---|
| **A. Space event** — a new `space.roomy.space.reportMessage.v0`, sent through `space.roomy.space.sendEvents` | the space stream, materialised into a per-space table | **every member of the space** (`#canReadStream`, `sync/handler.ts:437-449`), and the Discord bridge | space admins, via a new settings page |
| **B. ATProto moderation service** — `com.atproto.moderation.createReport` proxied to a labeler | the moderation service's own database | the service | the service — which cannot resolve a Roomy message id (§2.3) |
| **C. Roomy-owned queue** — a read-state table written by a new appserver procedure | the appserver's read-state DB (`data/roomy-readstate.sqlite`) | space admins, through a new admin-gated XRPC query | space admins, in app-lite space settings |

**The decision is C.** The reasoning follows; (A) and (B) are each defensible in
a different tree and both are worse here, for concrete reasons rather than
preference.

### 3.2 Why not a space event

(A) is the shape the tree's existing moderation action takes — a ban is an event
— and it is the cheapest to build: no new procedure, no new OAuth scope, no
read-state schema. The ban's whole apparatus carries over.

It is rejected on privacy, and the privacy failure is structural rather than a
matter of how the UI presents it. A space's stream is readable by every member:
`#canReadStream` (`packages/appserver/src/sync/handler.ts:437-449`) admits any
member or admin and denies only banned users, and `#streamEvents`
(`:1098-1120`) sends raw event payloads with no per-viewer filter. A report
written as an event is therefore:

- **Readable by the reported user.** A report names its reporter and its
  subject. Publishing it to the whole space tells the person reported who
  reported them, which is the harassment vector a report flow exists to close,
  and it tells every bystander too.
- **Readable by the Discord bridge**, which subscribes to the `stream:` topic per
  space (`packages/discord-bridge/src/roomy/live-gateway.ts:175`).
- **Replicated and replayed.** The event log is the durability layer; a report
  would be copied to every replica and re-materialised on every rebuild.

A ban does not have this problem because a ban is a *decision the space made*,
and its publicity is the point: it is a moderation record the community can see.
A report is a *private complaint to the moderators*, and the whole reason the
reporter uses the mechanism instead of a public call-out is that they expect it
to be private.

The tree states this doctrine already, for a different feature, in the exact
terms that apply here — `packages/appserver/src/db/readStateSchema.sql:260-273`
on the per-call LiveKit keys:

> Deliberately NOT an event: the event store is replayed, replicated, and
> readable by anyone who can read the stream, so a key written there would be a
> key published.

A report is the same shape of state: appserver-owned, meaningful only to a
privileged reader, and ruined by publication.

### 3.3 Why not `com.atproto.moderation.createReport` (yet)

(B) is the protocol-native answer and the one this plan would prefer on
principle. It is rejected for a mechanical reason that will stop being true.

`createReport`'s `subject` is a `repoRef` or a `strongRef` — a reference into a
repository (§2.6). A Roomy message is not in a repository (§2.3): it has no
`uri` and no `cid`. To call the method today we would have to synthesise a
subject, and the only honest-looking candidate —
`at://<spaceDid>/space.roomy.message/<ulid>` — is a URI that no repo serves and
no resolver can fetch. The service receives the reason text and cannot read the
content the reason is about. It cannot moderate, and it cannot even triage.

Worse than useless, it is *misleading*: it records a report as delivered to a
moderation service that has no way to act, which is exactly the failure mode
Guideline 1.2's "timely responses to concerns" is written against (§8).

Two things would change the answer, and neither is in this plan's scope:

1. **The permissioned-data protocol gives a message an atproto address** — i.e.
   a space record that a moderation service can resolve. The tree is heading
   this way (spaces already have a stewarded account and a
   `space.roomy.service/self` record,
   `packages/appserver/scripts/migrate-spaces-to-pds.ts:189`), but nothing
   commits messages there today, and no read path resolves one from a repo.
2. **Roomy runs or subscribes to a labeler.** There is no labeler in the tree:
   no `com.atproto.label.*` reference, no `#labeler` service, no label record.
   Standing one up (an Ozone deployment, or an in-house service with its own
   auth and storage) is a project several times the size of this flow.

The record this plan defines is therefore **shaped for that future** — its
reason field uses the protocol's own `reasonType` vocabulary (§4.1) — so that
adding the fan-out later is a mechanical addition of one call beside the local
write, not a re-modelling. That is the same argument user-blocks makes for
mirroring `app.bsky.graph.block`'s field-for-field shape.

### 3.4 What the decision costs, stated plainly

- **A new OAuth scope, and the two-gate deploy it requires.** A new appserver
  procedure is a new `rpc:` scope. Every appserver RPC is registered in
  `packages/app-lite/src/lib/scopes.ts:87-138` (`APPSERVER_RPCS`), which feeds
  `BASE_SCOPES` (`:187-210`) — the tier every login requests — and the metadata
  ceiling (`FULL_SCOPE_CEILING`, `:340-357`). The deployed HappyView API client
  validates the granted scope **set** and rejects all of it if one token is
  unregistered, which breaks sign-in for everyone. So the scopes must be
  registered on the HappyView client **before** the code that requests them
  merges (§7, Phase 0). Unlike the block's `repo:` scope there is no
  ceiling-only tier to park a `base` RPC in. The drift check
  (`packages/app-lite/scripts/check-oauth-scopes.mjs`, run by the `Check
  App-lite` CI job) fails only when a requestable tier contains a token that is
  listed in `UNREGISTERED_SCOPES` (`scopes.ts:178-181`) — so it catches the
  mistake only if the new tokens are also declared there first. Adding the NSIDs
  to `APPSERVER_RPCS` without touching `UNREGISTERED_SCOPES` fails nothing and
  ships a sign-in outage. Declaring them in `UNREGISTERED_SCOPES` in the same
  change is therefore what makes the ordering enforced rather than remembered.
- **Reports do not travel with a space.** The read-state DB is appserver-global
  and is not the unit of replication; the per-space DB is (see
  `packages/appserver/docs/plans/pure-materialisation.md`: "the per-space DB is
  the unit of scale"). A space migrating to another host carries its bans — they
  are events — and leaves its open report queue behind. This is accepted: a
  report is a short-lived operational artifact, its durable outcome is already
  an event, and the alternative is publishing accusations.
- **A second store for moderation state**, beside the event-sourced ban. The
  split is principled (§3.2: private vs public) but it is a split, and a reader
  who comes expecting "all moderation is an event" will find one exception. §5.5
  states the rule.

---

## 4. The record

### 4.1 The table

One row per report, in the read-state DB, beside `bridge_token_grants`
(`packages/appserver/src/db/readStateSchema.sql:194-213`) and `voice_call_keys`
(`:260-273`):

```sql
-- ── Content reports (schema v15) ────────────────────────────────────────
-- One row per (reporter, message). A report is a user's private complaint to
-- the moderators of a space, so — like voice_call_keys and unlike the ban —
-- it is NOT an event: the space stream is readable by every member
-- (`#canReadStream`), so an event-borne report would publish the reporter's
-- identity and their accusation to the whole room. The durable outcome of a
-- report is a ban or a delete, and those are already events.
--
-- The table is appserver-global because it spans spaces; `space_did` is the
-- scope key, indexed for the per-space queue query.
create table if not exists content_reports (
  id           text primary key,             -- ulid
  space_did    text not null,
  room_id      text not null,
  message_id   text not null,                -- ULID; the message being reported
  author_did   text not null,                -- the reported account (denormalised
                                             -- so the row survives a deleted message)
  reporter_did text not null,
  reason_type  text not null,                -- com.atproto.moderation.defs#reason*
  reason       text,                         -- optional free-text note
  status       text not null default 'open'
                 check (status in ('open', 'resolved', 'dismissed')),
  resolved_by_did text,                      -- admin who closed it
  resolved_at     integer,
  created_at   integer not null default (unixepoch() * 1000),
  -- One report per (reporter, message): a user re-reporting the same message
  -- updates nothing rather than stacking rows. This is the report-spam guard
  -- at the storage layer; the endpoint rate limit (§5.1) is the other.
  primary key (id)
) strict;
create unique index if not exists idx_content_reports_reporter_message
  on content_reports(reporter_did, message_id);
create index if not exists idx_content_reports_space_status
  on content_reports(space_did, status, created_at desc);
```

Added to `packages/appserver/src/db/readStateSchema.sql` and declared as
`"15": { kind: "structural" }` in `READSTATE_MIGRATIONS`
(`packages/appserver/src/db/readStateVersions.ts:53-156`; the current head is
`"14"` at `:142`). No `up` is needed: `readStateSchema.sql` is exec'd
idempotently on every open, so `create table if not exists` is already present
on both fresh and existing DBs (`readStateVersions.ts:1-25`).

**`author_did` is denormalised on purpose.** A report outlives the message it
names — `DeleteMessage` removes the entity and cascades its edges
(`packages/sdk/src/schema/events/message.ts:424-429`), after which
`getMessage` 404s. The author is what a moderator needs after the content is
gone (to ban them), and it is public by definition.

**`reason_type` reuses the protocol's vocabulary.** The values are
`com.atproto.moderation.defs#reason*` (§2.6) rather than a Roomy invention, so
Phase 3's fan-out to a moderation service is a field-for-field copy rather than
a translation.

### 4.2 The SDK projection

Two arktype schemas under `packages/sdk/src/schemas/{queries,procedures}/`, the
convention every XRPC endpoint follows
(`packages/sdk/src/schemas/queries/getMessages.ts` is the query template,
`packages/sdk/src/schemas/procedures/updatePolicy.ts` the procedure one):

- `space.roomy.report.createReport` — input `{ spaceId, messageId, reasonType,
  reason? }`.
- `space.roomy.report.getReports` — params `{ spaceId, status?, limit?, cursor? }`,
  response `{ reports: Report[], cursor? }`.
- `space.roomy.report.resolveReport` — input `{ reportId, status, note? }`, void
  output.

No new *record* lexicon is needed: the report is not an atproto record and is
never written to a repository, so there is nothing for a third-party client to
resolve. This is the opposite of the block, which is a repo record and gets a
lexicon (`packages/appserver/lexicons/space/roomy/user/block.json`).

---

## 5. The read/write path

### 5.1 Write: `space.roomy.report.createReport`

A **procedure**, authenticated, member-or-admin of the space. Following the
shape of an existing read-state-writing procedure —
`packages/appserver/src/handlers/space.roomy.space.grantBridgeToken.ts:1-17`
documents the contract, `:38-56` does validate → 401 → access check → write:

1. Validate `spaceId`, `messageId`; resolve the caller's DID (`parseUserDid`,
   `packages/appserver/src/xrpc/authGuards.ts:30-41`; 401 if null).
2. `requireSpaceAccess(openSpaceDb(spaceId), spaceId, userDid)`
   (`authGuards.ts:50-71`) — a report is a member action. A banned caller is
   refused here, which is correct: they cannot read the room either
   (`requireRoomRead`, `:111-149`).
3. Resolve the message to `(roomId, authorDid)` in the owning per-space DB via
   `openSpaceDbForEntity(messageId)` (`packages/appserver/src/db/db.ts:157-166`),
   then `requireRoomRead` so a report cannot name a message the caller cannot
   see. 404 if the message does not exist.
4. Refuse `authorDid === callerDid` — you cannot report your own message — and
   refuse a system message (`authorDid === spaceId`; see the `system` rule at
   `packages/appserver/src/queries/selectMessages.ts:531-534`).
5. Upsert into `content_reports`. The unique index makes a repeat report a
   no-op; the handler returns success either way so the client does not need to
   distinguish.
6. Rate-limit it. `createReport` joins `ENDPOINT_RATE_LIMITS`
   (`packages/appserver/src/xrpc/rateLimit.ts:183-188`, applied from
   `router.ts`) — a report endpoint is the classic spam target, and the
   allowlist is the tree's existing mechanism for a per-endpoint cap.

**Nothing is hidden, notified or materialised by this call.** It writes one row
and returns.

### 5.2 Read: `space.roomy.report.getReports`

A **query**, space-admin only. The gate is the space's own admin edge, and the
helper to copy is `requireFederationAdmin`
(`packages/appserver/src/handlers/federationAdmin.ts:30-60`) — parse DID → 401 →
`requireSpaceAccess` → `access.isAdmin` → 403 — which exists for exactly this
shape (a per-space admin-gated read) and is documented as such:

```ts
const access = await requireSpaceAccess(spaceDb, spaceId, userDid);
if (!access.isAdmin) throw new XrpcError(403, "Forbidden", `Only space admins can view ${viewLabel}`);
```

It reads `content_reports` from the read-state DB
(`openReadStateDb`, `packages/appserver/src/db/db.ts:201`), orders by
`created_at desc`, filters by `status`, pages on a `(created_at, id)` cursor.

**The reported message is rendered by the client, not embedded in the response.**
The list returns report rows plus, for each, the message id and room id; the
queue page fetches the message through the ordinary `space.roomy.message.getMessage`
(`packages/appserver/src/handlers/space.roomy.message.getMessage.ts:16-59`) when
the admin expands a row. Two reasons:

- **The queue is not a new content route.** Embedding a `MessageDto` per report
  would put a second full-message read path in the tree, with its own pagination
  and hydration, and it would have to be taught every rule the read path learns
  next (read-time redaction, for one). Fetching by id reuses the route that
  already exists.
- **It is what makes an open report readable when its author is blocked.** §5.5.

A message that has been deleted 404s, and the row renders "message no longer
available" plus the denormalised `author_did` (§4.1).

### 5.3 Resolve: `space.roomy.report.resolveReport`

A **procedure**, space-admin only. Sets `status` (`resolved` / `dismissed`),
`resolved_by_did`, `resolved_at`. A void output, registered with no
`outputSchema` — the convention for a procedure that returns nothing
(`packages/appserver/src/appserver.ts:229-234`, and the `sendEvents` case at
`:247-251`).

**Banning is not part of this procedure.** If the admin resolves by banning,
the client sends `space.roomy.space.banAccount.v0` through the existing
`sendEvents` path (`packages/app-lite/src/lib/mutations/send-events.ts:7-15`),
exactly as the members page does
(`packages/app-lite/src/routes/[space]/settings/members/+page.svelte:77-92`), and
then calls `resolveReport`. The ban stays where it is — an event, authorized by
`checkWriteAuth`, materialised into `comp_bans`, invalidated by
`handleBanAccount`. This flow adds an *entry point* to the ban, not a second
ban implementation.

The same holds for deleting the message: admin delete already exists
(`ChatMessage.svelte:281`, `DeleteMessageDialog.svelte:23-25`), and the queue
page links into the room rather than re-implementing it.

### 5.4 Invalidation

A resolved or new report changes one page: the queue. It is a read-state write,
not an event, so nothing in the materialiser's invalidation path
(`packages/appserver/src/invalidation/inferSignals.ts:1311` `HANDLERS`) fires.
The procedure emits its own signal, the way a handler does when it writes state
outside the log — the precedent is `space.roomy.room.updateSeen`, which builds
an `InvalidationEvent[]` and calls `router.emit(signals)`
(`packages/appserver/src/handlers/space.roomy.room.updateSeen.ts:120-215`):

- `createReport` → `{ kind: "queryInvalidation", signal: { nsid:
  "space.roomy.report.getReports", params: { spaceId } } }`, so an admin with the
  queue open sees the new row.
- `resolveReport` → the same, for the resolved row.

`space.roomy.report.getReports` must be added to the `QueryNsid` union
(`packages/appserver/src/invalidation/types.ts:28-48`) and to
`topicsForSignal`'s space-scoped case list
(`packages/appserver/src/sync/handler.ts:54-110`, where every
`space.roomy.space.*` query maps to the `space:<spaceId>` topic).

**It is not cacheable.** `CACHEABLE_NSIDS` (`packages/appserver/src/cache/index.ts:42-58`)
is an explicit allowlist of responses fully covered by the invalidation system;
a procedure-written, cursor-paginated list is outside it by construction ("…
cursor-paginated list queries are never cached", `:1-11`).

### 5.5 Where the two admins meet, and where they must not

Three interactions with the rest of the tree, each with a rule:

**A report is not a block, and the queue must not become a read bypass.** If the
admin viewing the queue has blocked the reported author, the ordinary read path
tombstones that message — in user-blocks' design, `selectMessages` returns a
content-free row for a hidden author and `getMessage` returns the full DTO only
to an admin who blocked the author themselves, in a space they administer
(`packages/app-lite/docs/plans/user-blocks.md`, §3.1 and §3.6). The reports page
must not add a third reveal path. It does not need one: it fetches by id through
`getMessage`, and the admin reading a report about an author *they blocked* is
precisely §3.6's case — clause 1 (`authorDid ∈ blocks(viewerDid)`) and clause 2
(`isAdmin` on the space) both hold. The rule is therefore: the queue renders
whatever `getMessage` returns, including a tombstone, and no report-specific
widening exists. If a future change makes a moderator need to read a message
they did not block, that is a decision for user-blocks and it belongs in that
plan.

**The gate is the space admin edge, never the service allowlist.** Both the
`getReports` query and the `resolveReport` procedure call
`isAdmin(db, spaceId, did)` (`packages/appserver/src/auth/access.ts:124-131`) or
the `requireFederationAdmin` helper that wraps it — **not** `requireAdmin`
(`packages/appserver/src/admin.ts:40-51`, the `APPSERVER_ADMIN_DIDS` allowlist).
The two are unrelated, a space admin is not on the operator allowlist and never
will be, and a handler written against the wrong one would hand every service DID
the contents of every space's moderation queue.

**A report does not hide anything.** v1 writes a row and nothing else. The
temptation — auto-hide a reported message until an admin reviews it — is rejected
in §9.1: it makes a single user's click a takedown lever, and it turns
`getMessages` into a per-reporter-shape query, which is the fan-out problem
user-blocks §3.6 spends a page avoiding.

---

## 6. The UI

### 6.1 The message affordance

`packages/design/src/components/content/thread/message/ToolbarShell.svelte`,
one `ContextMenuItem` in the "…" menu, inserted immediately **before** the
`{#if canDelete}` block at `:211` — the non-destructive side of the deliberate
divider that keeps Delete last (`:211-219`):

```svelte
{#if onReport}
  <ContextMenuItem onclick={onReport}>
    <IconFlag class="size-4" />
    Report
  </ContextMenuItem>
{/if}
```

- **The prop is `onReport?: () => void`**, added to the destructuring near
  `:32-40` and to the type near `:57-62`, mirroring `onCreateCard?` /
  `onSaveToCollection?`. Presence is eligibility — no boolean (`:37`, `:40`).
- **The icon** is a one-line addition to
  `packages/design/src/icons/index.ts` (`IconFlag = ~icons/ph/flag-bold`, beside
  `IconProhibit` at `:39`; `flag-bold` is present in the installed
  `@iconify-json/ph@1.2.2`).
- **When it is absent:** on the viewer's own message and on a system message.
  The caller computes that (`message.authorDid === currentUserDid`,
  `ChatMessage.svelte:242`; `isSystem`, `:225`) and passes `undefined`, the
  pattern `onCreateCard` already uses for a conditional action
  (`ChatMessage.svelte:661-663`).

### 6.2 Threading the callback

Four files, mirroring `onRequestDelete` hop for hop (§2.4):

| File | Add |
|---|---|
| `packages/app-lite/src/lib/components/chat/MessageToolbar.svelte` | `onReport?: () => void` in the props (`:7-28`), the destructuring (`:30-45`, beside `:44`), and the `<ToolbarShell …>` call (`:72-88`, beside `:86-87`) |
| `packages/app-lite/src/lib/components/chat/ChatMessage.svelte` | `onReport?: (message: Message) => void` in the props (`:49-70`), the destructuring (`:85-87`), and the toolbar snippet (`:647-670`, beside `:661-666`) — passed only when `!isAuthor && !isSystem` |
| `packages/app-lite/src/lib/components/chat/ChatArea.svelte` | `onReport` in the props (`:34-46`, beside `:43`), the destructuring (`:46`), and the per-row pass-through (`:525-539`, beside `:536`) |
| `packages/app-lite/src/routes/[space]/[room]/+page.svelte` | the handler and dialog state, beside `openDeleteConfirm` (`:76-80`); `onReport={openReport}` on both `<ChatArea>` call sites (`:419`, `:455`); the dialog near `<DeleteMessageDialog>` (`:480-491`) |

### 6.3 The confirm step

A new component beside the delete dialog —
`packages/design/src/components/content/thread/message/ReportMessageDialog.svelte`
— modelled on `DeleteMessageDialog.svelte`:

- `import { Modal } from "@foxui/core"` (`DeleteMessageDialog.svelte:2`),
  `<Modal bind:open closeButton={true} class="gap-6">` (`:54`), the Cancel /
  submit button pair (`:84-92`), and the `deleting`-style in-flight guard that
  sets `open = false` in a `finally` (`:42-53`).
- Props: `open = $bindable(false)`, `authorName?` (for the copy), `onConfirm:
  (reasonType: string, reason?: string) => void | Promise<void>`.
- Body: a reason picker over the protocol's vocabulary (§4.1) and an optional
  note. A `ToggleGroup` is the existing primitive for a small fixed choice set
  (`packages/app-lite/src/routes/[space]/settings/federations/+page.svelte:18`).
- The submit calls `createReport(spaceId, messageId, reasonType, reason)` and
  then `toast.success` / `toast.error` — the toast host is
  `packages/app-lite/src/routes/+layout.svelte:229` (`<FxUIToaster />`), and
  `toast` from `@foxui/core` is the convention for a completed action
  (`packages/app-lite/src/routes/[space]/settings/members/+page.svelte:87`,
  `:90`).

The client mutation is a plain async function, not a hook — there is no
`createMutation` anywhere in app-lite. The shape is
`packages/app-lite/src/lib/mutations/bridge-tokens.ts:11-21`: call
`px().procedure(...)`, then `queryClient.invalidateQueries`.

### 6.4 The moderation queue

**In app-lite space settings, not in `packages/docs`.** This is a decision, and
the reasoning is the distinction §2.5 draws: a report queue is for the space's
own moderators, who are not — and cannot be — on the operator allowlist. Putting
it behind `PUBLIC_APPSERVER_ADMIN_DIDS` would mean promoting every space admin to
a service operator. (The counterargument — that an operator may want a
cross-space view of reports to spot a space under attack — is noted as a
possible later aggregate on the dashboard, `packages/docs/src/routes/dashboard/+page.svelte`,
beside `callAdminListSpaces` at `packages/docs/src/lib/xrpc.ts:303`. It is not in
v1 and it is not the queue.)

The page is a new admin-gated route:

- `packages/app-lite/src/routes/[space]/settings/reports/+page.svelte`, modelled
  on `federations/+page.svelte:1-35`: `isAdmin` from
  `createSpaceMetadataQuery` (`packages/app-lite/src/lib/queries/space-metadata.ts`),
  the query created with `enabled: () => isAdmin` (the federation queries'
  gate, `packages/app-lite/src/lib/queries/federation.ts:11-56`).
- A tab in `settingsTabs` (`packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:197-210`),
  gated like `showFederationTab` (`:190`), and a case in the title switch
  (`packages/app-lite/src/routes/[space]/settings/+layout.svelte:18-44`).
- Each row: when, who reported, the reason, the reported author, an expand
  control that fetches the message via `getMessage` and renders it with the
  existing `MessageBubble` (so it inherits every rendering rule), and two
  actions — **Dismiss** (`resolveReport(status: "dismissed")`) and
  **Ban and resolve** (send the `banAccount.v0` event, then
  `resolveReport(status: "resolved")`).
- An empty state, and a count of open reports on the tab.

**The reporter's identity is shown to the admin and to nobody else.** That is
the point of a moderated channel: the moderator can follow up, and the reported
user cannot retaliate. Nothing in the queue is exposed on any member-facing
route, and — §3.2 — nothing is in the stream.

---

## 7. Phasing

Format and dispatch model follow `packages/app-lite/docs/plans/user-blocks.md`
§6 and `packages/app-lite/docs/plans/progressive-scope-extension.md`: each phase
is one task, on a stacked branch, and every phase ships on its own.

```
next
 └── <worker>/content-reporting-p1   (report a message; admin queue)  — TestFlight-acceptable
      └── <worker>/content-reporting-p2   (queue hardening: lifecycle, notification, search)
           └── <worker>/content-reporting-p3   (account reports + the ATProto fan-out)
```

### Phase 0 — the OAuth scope, out of band (not a code phase)

The three new NSIDs enter `APPSERVER_RPCS`
(`packages/app-lite/src/lib/scopes.ts:87-138`) in Phase 1, and a `base` RPC has
no ceiling-only tier to wait in (§3.4). So before Phase 1 merges, the
`rpc:space.roomy.report.createReport?aud=*`,
`rpc:space.roomy.report.getReports?aud=*` and
`rpc:space.roomy.report.resolveReport?aud=*` must be registered on the HappyView API client and
on the dev loopback client. Nothing in the repository depends on this step
landing first — and if it is skipped, sign-in breaks for every user.

**Acceptance:** the scopes are present on both clients' allowlists.

### Phase 1 — Report a message, and the queue that receives it

**Base:** `next`. **Depends on:** Phase 0. **This is the slice that satisfies
Guideline 1.2's reporting clause (§8).**

1. `packages/appserver/src/db/readStateSchema.sql`: the `content_reports` table
   (§4.1); `"15": { kind: "structural" }` in `readStateVersions.ts`.
2. `packages/appserver/src/queries/contentReports.ts` — the read-state query
   helper (insert, select-by-space, resolve), following
   `queries/bridgeTokens.ts:28-40` and `queries/userOauthGrants.ts:24-45`.
3. SDK: `src/schemas/procedures/space.roomy.report.createReport.ts` and
   `.resolveReport.ts`, `src/schemas/queries/space.roomy.report.getReports.ts`;
   entries in `src/schemas/{procedures,queries}/index.ts`; entries in
   `src/transport/registry.ts` (`QUERY_SCHEMAS` `:15`, `PROCEDURE_SCHEMAS` `:166`);
   `pnpm --filter @roomy-space/sdk generate:lexicons`
   (`packages/sdk/scripts/generate-lexicons.ts:58-59`).
4. Appserver: `src/handlers/space.roomy.report.createReport.ts`,
   `.resolveReport.ts`, `src/handlers/space.roomy.report.getReports.ts`;
   registration in `buildRouter` (`packages/appserver/src/appserver.ts:206`);
   a `report` entry in `GROUP_BY_CATEGORY`
   (`packages/docs/scripts/generate-registry.ts:28-44`, defaulting to `"Other"`
   without it); prose for all three NSIDs in
   `packages/docs/src/lib/endpoints/prose.ts:35` and a regenerated
   `nsids.generated.json` (`pnpm --filter docs generate:registry`), both
  required by `check-docs` (`packages/docs/scripts/check-registry.ts:31-52`,
  `.github/workflows/ci.yml:311-330`); the `Check App-lite` job
  (`.github/workflows/ci.yml:265-288`) runs the scope drift check.
5. Rate limit: an entry in `ENDPOINT_RATE_LIMITS`
   (`packages/appserver/src/xrpc/rateLimit.ts:183-188`).
6. Invalidation: `space.roomy.report.getReports` in the `QueryNsid` union
   (`packages/appserver/src/invalidation/types.ts:28-48`), the space-topic case
   (`packages/appserver/src/sync/handler.ts:54-110`), and the handler-emitted
   signals (§5.4).
7. Client scopes: the three NSIDs in `APPSERVER_RPCS`
   (`packages/app-lite/src/lib/scopes.ts:87-138`) **and**, until Phase 0 has
   registered them, in `UNREGISTERED_SCOPES` (`:178-181`) — that is what makes
   the CI drift check fail if the registration is skipped (§3.4).
8. Client mutation + query: `lib/mutations/reports.ts`,
   `lib/queries/reports.ts` (§6.3, §6.4 shapes).
9. Design: `ReportMessageDialog.svelte`; `ToolbarShell`'s `onReport` prop, menu
   item and `IconFlag` (§6.1).
10. app-lite: the four-hop threading (§6.2) and the
    `[space]/settings/reports/` page plus its tab (§6.4).
11. Tests:
    - Handler: a member can report a visible message; a non-member 403s; a
      report of one's own message and of a system message is refused; a report
      of a nonexistent message 404s; a duplicate report is a no-op (one row).
    - Gate: `getReports` returns rows to a space admin and 403s to a member and
      to a service DID that is not a space admin — the §5.5 rule, asserted.
    - `resolveReport` sets status and attribution, and 403s a non-admin.
    - The queue response carries no `MessageDto` (§5.2) and no field the
      member-facing routes do not already expose.

**Acceptance:** a member opens the "…" menu on someone else's message, reports
it with a reason, sees a success toast, and is not told what happens next. A
space admin opens Settings → Reports, sees the row with the reporter, reads the
message, and either dismisses it or bans the author and resolves it. A
non-admin member has no Reports tab and gets a 403 from the query. Nothing about
the report appears in the space's stream.

### Phase 2 — The queue as an operational surface

**Base:** `<worker>/content-reporting-p1`. **Depends on:** Phase 1. This is what
turns a working mechanism into "timely responses to concerns" (§8.2).

1. **Notify admins of a new report**, or the queue is only found by luck. The
   options, in the tree's own vocabulary: a badge count on the settings tab; an
   unread-style row via `notificationState`
   (`packages/appserver/src/queries/notificationState.ts`); or a push through
   `push/evaluate.ts` to the space's admins. The decision is §9.3.
2. **Status lifecycle beyond open/closed**: an `escalated`/`reviewing` state, and
   an append-only note trail so several moderators can work the queue without
   losing each other's context.
3. **Search and filter**: by room, by author, by reporter, by date. The space
   could hold thousands of open reports after an incident.
4. **An admin's own report list.** A user who has reported content should be able
   to see that it was received, without seeing the outcome or the moderation
   discussion. This is a member-facing page and it is a *new* exposure — the
   design must decide what a reporter may learn (§9.4).
5. **The operator aggregate** (§6.4): an open-report count per space on the
   dashboard, if operations want it.

**Acceptance:** a report reaches an admin without them opening the settings page
first; the queue is workable at a hundred open rows; a reporter can see that
their report was received.

### Phase 3 — Account reports, and the protocol fan-out

**Base:** `<worker>/content-reporting-p2`. **Depends on:** Phase 2.

1. **Report an account**, not just a message: an affordance on the profile page
   beside Block (`packages/app-lite/src/routes/user/[user]/+page.svelte:479-491`),
   reusing the same table with `message_id` nullable and the subject carried by
   `author_did`. This is the sibling of the block button and shares its
   `guardedXrpc` consent machinery (`packages/app-lite/src/lib/scope-guard.ts:141`).
2. **The ATProto fan-out, when it becomes possible.** If a Roomy message gains a
   resolvable atproto address (the permissioned-data protocol), or Roomy runs or
   subscribes to a labeler, `createReport` additionally calls
   `com.atproto.moderation.createReport` with the now-resolvable subject,
   alongside the local row. §3.3 gives both conditions; §4.1's `reason_type` is
   already the protocol's vocabulary, so this is a call and a mapping, not a
   re-modelling. Until then, **do not send it** — a report a moderator service
   cannot resolve is worse than no report (§3.3).

**Acceptance:** an account can be reported; and, only if the precondition holds,
the report is also delivered to a moderation service the reporter's content is
actually addressable on.

---

## 8. App Store acceptance mapping

### 8.1 The guideline, verbatim

> **1.2 User-Generated Content** Apps with user-generated content present
> particular challenges, ranging from intellectual property infringement to
> anonymous bullying. To prevent abuse, apps with user-generated content or
> social networking services must include:
>
> - A method for filtering objectionable material from being posted to the app
> - A mechanism to report offensive content and timely responses to concerns
> - The ability to block abusive users from the service
> - Published contact information so users can easily reach you

(fetched from `developer.apple.com/app-store/review/guidelines/`, 2026-10-13.)

It continues: *"It is your responsibility to remove content that violates this
guideline, your terms of service, or your community standards. If we find such
content, we will ask you to remove it…"* — so removal is part of the obligation,
not only reporting.

### 8.2 Which piece satisfies which clause

| Clause | What satisfies it | State |
|---|---|---|
| **A method for filtering objectionable material from being posted** | **Nothing in this plan, and nothing in the tree.** There is no content filter of any kind — no profanity list, no blocklist, no classifier, no moderation-ahead-of-post step (searched: `profanit`, `blocklist`, `denylist`, `nsfw`, `safe search` across `packages/{app-lite,appserver,design,sdk}/src`; no matches). | **Open.** See §8.3. |
| **A mechanism to report offensive content** | This plan, Phase 1: the message toolbar's Report action (§6.1), the reason dialog (§6.3), the procedure (§5.1), and the admin queue (§6.4). | Phase 1 |
| **…and timely responses to concerns** | Phase 1's queue is the mechanism; **the response time is a human commitment, not code.** Phase 2's admin notification (§7) is what makes a prompt response operationally possible. | Phase 1 mechanism, Phase 2 workable |
| **The ability to block abusive users** | The blocking half, `packages/app-lite/docs/plans/user-blocks.md`: the Block affordance on a profile ships in its Phase 1 (`packages/app-lite/src/routes/user/[user]/+page.svelte:479-491`, behind the `user-blocks` flag, `packages/appserver/src/featureFlags.ts:53-56`), and the read-path enforcement is its Phases 2–3. | Affordance shipped; enforcement planned |
| **Published contact information** | App Store Connect's **Support URL** is the field App Review checks, and it needs to reach a page with a working contact route. In-app, the only outward link is "About Roomy" → `https://a.roomy.space` (`packages/app-lite/src/routes/+page.svelte:44-46`, opened in the OS browser by the shell's link router, `packages/app-lite/src/lib/link-routing.ts:79-129`). There is **no in-app support or contact entry** — the user-settings nav has General / Notifications / Subscription / Access and nothing else (`packages/app-lite/src/routes/user/settings/+layout.svelte:101-141`). | **Needs a Support URL and, ideally, an in-app entry.** Non-code for the URL; one nav row for the entry. |
| **Removing content that violates the guideline** | Already shipped: an admin can delete any message (`packages/app-lite/src/lib/components/chat/ChatMessage.svelte:281` — `canDelete = isAuthor || isAdmin`; `DeleteMessageDialog.svelte:23-25`), and can ban the author (§2.1). Phase 1's queue is the entry point to both. | Shipped |

### 8.3 What "done" looks like for a review

The concrete checklist for a TestFlight-acceptable build, and what to put in the
review notes:

1. **The reviewer can reach the report action.** Signed in as a member, on
   another user's message, the "…" menu shows **Report**. *(Phase 1.)*
2. **The reviewer can complete a report.** Choosing a reason and confirming
   shows a success confirmation and does not navigate away or expose the
   reporter's report to anyone else. *(Phase 1.)*
3. **The reviewer can see the other side.** As a space admin: **Settings →
   Reports** lists the report with its reason, its reporter, and the reported
   message, and offers Dismiss and Ban-and-resolve. *(Phase 1. This is the row
   that matters most: it is the demonstration that the report goes somewhere a
   human reads.)*
4. **A non-admin sees none of it.** No Reports tab; the query 403s. *(Phase 1,
   asserted by test.)*
5. **Blocking is present and honest.** The reviewer can block a user from their
   profile. The review notes should describe what blocking does in the build
   being reviewed — today, the record is written and enforcement is the
   in-flight work (`user-blocks` Phases 2–3) — rather than claim more than the
   build does.
6. **Removal works.** An admin can delete a reported message. *(Shipped; no work
   needed, but worth a note because Guideline 1.2 makes removal an explicit
   obligation and this is where it is demonstrated.)*
7. **Contact information is published.** The Support URL in App Store Connect
   resolves to a page with a working contact route. *(Non-code, plus optionally
   one nav row — §8.2.)*
8. **The filtering clause is addressed or explained.** §8.2's first row is the
   one clause neither this plan nor the tree answers. Two honest options, and
   the team should pick one before submitting rather than let it surface as a
   rejection: ship a **minimum filter** (for example, a client-side and
   server-side check on a maintained term list at post time, or a
   hold-and-review state for messages from accounts with no history in the
   space), or **describe the post-moderation posture in the review notes** —
   reporting, blocking, removal and human review — and accept the risk that a
   reviewer wants the fourth bullet demonstrated. The first is a small project
   of its own; the second is free and is what several UGC apps do. The plan
   records the choice as open (§9.2) rather than pretending it is covered.
9. **The response-time commitment is real.** Guideline 1.2 asks for *timely*
   responses, and no code can assert that. Before submitting, name who watches
   the queue and at what cadence — and, when Phase 2 lands, that the notification
   actually reaches them.

---

## 9. Decisions

**1. Does a report hide the content it names, until an admin reviews it?**

**Decided: no. v1 hides nothing.** A report writes one row.

The case for auto-hide is real — it is closer to "filtering objectionable
material", and it protects the reporter from having to keep seeing the message
while the queue drains. It is rejected for two reasons:

- **It makes one click a takedown lever.** A single user could hide any message
  in the space, and a coordinated few could clear a room. Every UGC app that
  ships this ends up rate-limiting it, gating it behind trust levels, or
  reverting it; the trust machinery does not exist here, and building it is a
  larger project than the report flow.
- **It puts a per-viewer shape on a shared read path.** The room timeline is
  built once and fanned to every subscriber
  (`packages/appserver/src/sync/handler.ts:457-489`, `#canReceiveRoomContent`),
  and the client's cache is keyed per query, not per reporter. A per-reporter
  hidden set is the same fan-out problem user-blocks §3.6 spends a page
  keeping off the fan-out path — and it would have to be taught to every route
  that can carry a message. That is a project, and it is the *blocking* project.

The right lever for a user who wants a message gone from their own screen is
**block**, which is in flight and is per-viewer by design. Reporting is for the
case where the user thinks the *space* should act.

**2. Is a report anonymous to the admin?**
**Decided: no.** The reported user never learns who reported them, but the
space's admins do. A moderation queue whose entries are anonymous cannot be
worked: an admin cannot ask a follow-up question, spot one user filing twenty
reports against one person, or distinguish a report from the person being
reported. The reporter's identity is shown to space admins and to no one else —
which is exactly what the read-state store (§3.2) is for.

**3. How does an admin learn a report arrived?** *(open)*
**Recommendation: a count badge on the Reports tab in Phase 1, and a push to the
space's admins in Phase 2.** The badge is free — the page already fetches the
list, and the tab can show `open` count — and it makes the mechanism workable
without inventing a notification kind. Push is the right long-term answer for
"timely responses", and the machinery exists (`packages/appserver/src/push/evaluate.ts`,
which already enumerates recipients per message and therefore has the shape for
"per space admins"). It is Phase 2 because a new recipient class in the push
evaluator deserves its own change, and Phase 1 does not depend on it.

**4. What may a reporter see about their own report?**
**Decided: that it was received; nothing about the outcome or the discussion.**
Phase 1 shows only a success toast. Phase 2 may add a "your reports" list holding
`{ message snippet, when, status }` — status meaning open/closed, not the
moderation reasoning and not who else reported. The line is that the reporter
learns their report was not ignored, and does not learn anything that would
identify a decision-maker or expose the moderation conversation. A full
"resolution reason" back to the reporter is a support-desk feature, not a chat
feature, and is not planned.

**5. Can a report target an account rather than a message?** *(this plan says
message-only; account reports are Phase 3)*
The affordance the requirement names is content, and the content affordance is
the message toolbar — that is why v1 is message-shaped. An account-level report
is a genuine need (abusive profiles, impersonation) and it is scheduled as
Phase 3 §7, on the profile page beside Block, where the block affordance already
lives. It reuses the same table with a nullable `message_id`.

**6. Does a report go to the service operator?**
**Decided: no.** The queue is a space-admin surface in app-lite (§6.4). Service
operators see the endpoint catalogue entry and nothing else. The optional
operator aggregate — a per-space open-report count on the dashboard — is a
possible Phase 2 addition and is deliberately not a view of report contents:
operators already have database access, and a second route into private
complaints is a liability, not a feature.

**7. New `space.roomy.report.*` NSID category, or `space.roomy.space.*`?**
**Decided: a new `report` category.** It matches the tree's pattern of grouping
by subject (`space.roomy.mention.*`, `space.roomy.embed.*`, `space.roomy.voice.*`)
rather than by scope, and it keeps the three endpoints together for a reader.
The cost is one line in `GROUP_BY_CATEGORY`
(`packages/docs/scripts/generate-registry.ts:28-44`) — without which they land in
`"Other"` — and that is all.

**8. Is the report's reason vocabulary Roomy's own, or the protocol's?**
**Decided: the protocol's** — `com.atproto.moderation.defs#reason*` (§2.6,
§4.1). Even though the report is never sent there today, using the protocol's
tokens makes Phase 3's fan-out a copy, and it means a future third-party client
that reads Roomy reports does not have to learn a second vocabulary for a
solved problem. The cost is that the protocol's list is long and partly
Bluesky-specific (`reasonAppeal`, the `tools.ozone.report.defs#*` set); the
picker exposes a short, curated subset and the stored value is the full token.

**9. Should `resolveReport` write the ban itself?**
**Decided: no.** The ban stays `space.roomy.space.banAccount.v0` through
`sendEvents`, authorized by `checkWriteAuth` and materialised into `comp_bans`
(§2.1). The queue's "Ban and resolve" action sends that event and then resolves
the report. A second ban path would duplicate the authorization, the
materialiser and the invalidation, and the tree has one write path into a
space's log for a reason.

---

## References

**In-tree — the moderation primitive this plan sits beside**
- `packages/appserver/src/db/schema-space.sql:310-318` — `comp_bans`
- `packages/sdk/src/schema/events/space.ts:299-333` — `BanAccount` /
  `UnbanAccount`; `:420-431` the variant union
- `packages/sdk/src/schema/events/registry.ts:90-91`
- `packages/appserver/src/auth/writeAuth.ts:44-46` (`REJECTED_TYPES`),
  `:52-101` (`ALLOWED_TYPES`), `:168-186` (`SPACE_MANAGE_TYPES`),
  `:348-360` (`requireSpaceAdminCheck`), `:937-939` (dispatch)
- `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:157-181`,
  `:207`
- `packages/appserver/src/invalidation/inferSignals.ts:79-90` (`invalidate`),
  `:977-996`, `:1311-1360` (`HANDLERS`)
- `packages/appserver/src/auth/access.ts:124-131` (`isAdmin`), `:159-176`
  (`spaceAccessCached` / `queryIsAdmin`), `:193` (`queryIsBanned`)
- `packages/appserver/src/queries/members.ts:88-102`
- `packages/app-lite/src/routes/[space]/settings/members/+page.svelte:37-41`,
  `:77-110`, `:151-180`

**In-tree — the read path this flow must not disturb**
- `packages/appserver/src/queries/selectMessages.ts:55-102` (`MessageDto`),
  `:104-129` (`SelectScope`), `:516-519` (the `system` rule)
- `packages/sdk/src/schemas/queries/_message.ts:91-137`
- `packages/appserver/src/handlers/space.roomy.message.getMessage.ts:16-59`
- `packages/appserver/src/handlers/space.roomy.room.getMessages.ts:28-87`
- `packages/appserver/src/sync/handler.ts:54-110` (`topicsForSignal`),
  `:437-449` (`#canReadStream`), `:457-489` (`#canReceiveRoomContent`),
  `:1070-1090` (`#canReceiveStream`), `:1098-1120` (`#sendStreamEvents`)
- `packages/appserver/src/db/eventsSchema.sql:3-13` (`stream_events`)
- `packages/appserver/src/streams/StreamManager.ts:208`
- `packages/appserver/src/db/schema-space.sql:153-161` (`comp_content`)
- `packages/sdk/src/schema/events/message.ts:400-433` (`DeleteMessageSchema`,
  the entity cascade)

**In-tree — storage and the read-state precedent**
- `packages/appserver/src/db/readStateSchema.sql:1-10` (the read-state contract),
  `:194-213` (`bridge_token_grants`), `:260-273` (`voice_call_keys` — the
  "deliberately not an event" doctrine)
- `packages/appserver/src/db/readStateVersions.ts:1-25`, `:46-52`, `:142-158`
- `packages/appserver/src/queries/bridgeTokens.ts:28-40`,
  `queries/userOauthGrants.ts:24-45`
- `packages/appserver/src/handlers/space.roomy.space.grantBridgeToken.ts:1-17`,
  `:38-56`
- `packages/appserver/src/db/db.ts:157-166` (`openSpaceDbForEntity`), `:174`
  (`openGlobalDb`), `:201` (`openReadStateDb`)
- `packages/appserver/src/db/schema-global.sql:124-131` (the `mentions` global
  index — a cross-space table with a `space_did` column, the shape `content_reports`
  follows)

**In-tree — the XRPC checklist a new endpoint touches**
- `packages/appserver/src/appserver.ts:206` (`buildRouter`), `:229-234`
  (void-procedure registration), `:247-251` (`sendEvents`), `:352` (`getMembers`)
- `packages/appserver/src/xrpc/types.ts`, `xrpc/authGuards.ts:30-192`,
  `xrpc/params.ts`, `xrpc/errors.ts`, `xrpc/rateLimit.ts:183-188`, `:209`
- `packages/appserver/src/handlers/federationAdmin.ts:30-60`
  (`requireFederationAdmin`)
- `packages/appserver/src/admin.ts:39-51` (`requireAdmin` — the *other* admin)
- `packages/sdk/src/schemas/queries/index.ts`, `schemas/procedures/index.ts`,
  `transport/registry.ts:15`, `:166`
- `packages/sdk/scripts/generate-lexicons.ts:1-48`, `:58-59`
- `packages/docs/scripts/generate-registry.ts:28-44`, `:53`
- `packages/docs/scripts/check-registry.ts:18-52`
- `packages/docs/src/lib/endpoints/prose.ts:25-35`, `:643`, `:723`, `:821`
- `packages/docs/src/lib/endpoints/nsids.generated.json` (72 NSIDs)
- `packages/app-lite/src/lib/scopes.ts:87-138`, `:178-181`, `:265-275`,
  `:340-357`
- `.github/workflows/ci.yml:265-288` (check-app-lite + scope drift),
  `:290-310` (check-sdk), `:311-330` (check-docs)

**In-tree — the client seam**
- `packages/design/src/components/content/thread/message/ToolbarShell.svelte:8-20`
  (icon imports), `:22-63` (props), `:161` (the menu), `:175-219` (items, the
  `canDelete` divider at `:211-219`)
- `packages/design/src/components/content/thread/message/DeleteMessageDialog.svelte:2`,
  `:6-27`, `:42-53`, `:54`, `:84-92`
- `packages/design/src/components/content/thread/message/MessageBubble.svelte:23-60`
  (props), `:99` / `:104` (snippet slots)
- `packages/design/src/components/ui/context-menu/ContextMenu.svelte:4-30`,
  `ContextMenuItem.svelte:4-7`, `index.ts:1-3`
- `packages/design/src/icons/index.ts:12-44`
- `packages/app-lite/src/lib/components/chat/MessageToolbar.svelte:7-28`,
  `:30-45`, `:67-69`, `:72-88`
- `packages/app-lite/src/lib/components/chat/ChatMessage.svelte:45-72`, `:85-87`,
  `:225` (`isSystem`), `:242` (`isAuthor`), `:281` (`canDelete`), `:647-670`
- `packages/app-lite/src/lib/components/chat/ChatArea.svelte:27-44`, `:53`,
  `:525-539`
- `packages/app-lite/src/routes/[space]/[room]/+page.svelte:76-80`, `:419`,
  `:455`, `:480-491`
- `packages/app-lite/src/routes/+layout.svelte:229` (`<FxUIToaster />`)
- `packages/app-lite/src/lib/mutations/bridge-tokens.ts:11-21`,
  `mutations/send-events.ts:7-15`, `mutations/blocks.ts:29-116`
- `packages/app-lite/src/lib/queries/space-metadata.ts`,
  `queries/members.ts:1-35`, `queries/federation.ts:11-56`
- `packages/app-lite/src/lib/scope-guard.ts:33-158`,
  `lib/scope-consent-dialogue.ts:28-56`
- `packages/app-lite/src/routes/user/[user]/+page.svelte:47-53`, `:83-117`,
  `:479-491`

**In-tree — the admin surfaces, and the distinction between them**
- `packages/app-lite/src/lib/components/sidebar/SpaceSidebar.svelte:179-210`
- `packages/app-lite/src/routes/[space]/settings/+layout.svelte:18-44`
- `packages/app-lite/src/routes/[space]/settings/federations/+page.svelte:1-35`
- `packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:375`
- `packages/appserver/src/handlers/space.roomy.sync.getEvents.ts:7-13`, `:32`
- `packages/docs/src/routes/dashboard/+page.svelte:220-230`
- `packages/docs/src/lib/auth.svelte.ts:42-44`, `lib/config.ts:9-15`,
  `lib/xrpc.ts:277-310`, `lib/components/Sidebar.svelte:131-138`

**In-tree — contact information, and what is missing**
- `packages/app-lite/src/routes/+page.svelte:44-46` ("About Roomy" → `a.roomy.space`)
- `packages/app-lite/src/lib/link-routing.ts:36-129`,
  `lib/external-link-handler.ts`
- `packages/app-lite/src/routes/user/settings/+layout.svelte:101-141`

**Related work**
- `packages/app-lite/docs/plans/user-blocks.md` — the blocking half; §3.1's
  read-time redaction and §3.6's admin reveal are the two places §5.5 meets it
- `docs/open-social-proposal-8-oct.md:60-66` — the community-moderation shape
  (reports in, labels out, a moderation information architecture)
- `packages/appserver/docs/plans/pure-materialisation.md` — why the per-space DB
  is the unit of scale, and therefore why a report does not live in it

**External**
- App Store Review Guidelines §1.2, User-Generated Content —
  https://developer.apple.com/app-store/review/guidelines/ (fetched 2026-10-13)
- `com.atproto.moderation.createReport` —
  `bluesky-social/atproto`, `lexicons/com/atproto/moderation/createReport.json`
  (fetched 2026-10-13)
- `com.atproto.moderation.defs` —
  `bluesky-social/atproto`, `lexicons/com/atproto/moderation/defs.json`
  (fetched 2026-10-13)
- `com.atproto.repo.strongRef` — https://atproto.com/specs/lexicon (the `{uri,
  cid}` reference a Roomy message cannot produce)
