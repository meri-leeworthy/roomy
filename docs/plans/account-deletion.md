# Account deletion — Implementation Plan

**Date:** 2026-10-14
**Status:** Planned. Not started. §1 is the research finding the rest of the
document rests on; §3 is the decision record and is the section to argue with
first. §9's questions are all answered (§8 decisions 10–16) and no longer gate
Phase 1. §7 is what App Review reads.
**Next:** Phase 1 (§6.1) — the deletion surface, the appserver purge, and the
hand-off link. It is the TestFlight-acceptable minimum and is independently
shippable. It is gated on one out-of-band step that must happen *before* the
code merges (§4.2): registering the new scope on the HappyView API client.
**Scope now fixed at Phase 1.** Phase 2 (deleting the user's own messages in
shared spaces) is **not planned for the near term** (§6.2): Roomy treats space
content as partly community-owned, and 5.1.1(v) does not compel per-message
deletion. Phase 1's disclosure copy therefore has to be precise about it rather
than promising it — §3.8 and §7.1 are written that way.
**Verified against:** `origin/next` @ `508df18fd`, plus live network
measurements taken 2026-10-13 (§1.3, §10).
**Packages:** `packages/appserver`, `packages/app-lite`, `packages/sdk`,
`packages/docs`.

**Path choice.** This document lives at `docs/plans/account-deletion.md`. The
root `docs/plans/` directory holds the cross-package plan documents
(`bluesky-publishing.md`, `voice-chat-plan.md`, `web-tiles-integration.md`);
this work adds an XRPC procedure (appserver + SDK + docs registry) and a
settings route (app-lite), so the root directory is correct.

---

## 0. The ask, and what this document answers

Apple requires that an app which lets users create an account must also let
them delete it from inside the app — App Store Review Guideline **5.1.1(v)**
(§7.1). The open question is what "delete my account" can mean for a Roomy
user, given that a Roomy account *is* an ATProto identity the user owns.

This document answers five things:

1. What "the reference `/account` page" is (§1). **It is not in this repo.**
2. What a Roomy user's account actually consists of, and therefore which half
   of it a button in Roomy can act on (§2).
3. The deletion model, chosen from three options with the reasoning (§3).
4. The write path: one new XRPC procedure, what it clears, and its auth model
   (§4).
5. Phases, each independently shippable, with Phase 1 as the concrete
   TestFlight-acceptable slice (§6), and the guideline clause each artifact
   answers (§7).

**Not in scope:** deleting anything in the user's own ATProto repository; any
change to the PDS; a data-export/portability flow (a separate requirement, not
raised here).

---

## 1. "The reference `/account` page" — the reading, with evidence

### 1.1 There is no `/account` page in this repository

The phrase does not resolve to anything in the tree. The complete app-lite
route set — every `+page.svelte` under `packages/app-lite/src/routes/` — is
`/`, `/build.json`, `/join/[[spaceRef]]`, `/new`, `/search`,
`/user/settings{,/notifications,/scopes,/subscription}`, `/user/[user]`, and
the `/[space]` tree (`+page.svelte` plus `settings/*`). No `account` segment
anywhere. The generated route manifest agrees and adds nothing, but it is
gitignored (`.gitignore:5`), so the source glob is the citable form.

The only account-management surface that exists in the app is
`/user/settings/scopes`, labelled **Access** in the settings nav
(`packages/app-lite/src/routes/user/settings/+layout.svelte:131-140`), gated
behind the `access-settings` feature flag
(`packages/appserver/src/featureFlags.ts:47-51`), and it lists the two
*opt-in capabilities* (Semble collections, Bluesky DMs) — it is not a page
that can delete anything.

Nothing anywhere points at an ATProto or Bluesky account-management surface:
`account.bsky.app`, `settings/account`, `com.atproto.server.deleteAccount` and
`com.atproto.server.deactivateAccount` produce zero hits across the repo, and
no plan document describes an `/account` page. The only two related strings
in the tree are the `chat.bsky.actor.deleteAccount` /
`chat.bsky.actor.exportAccountData` scope tokens in the DM tier
(`packages/app-lite/src/lib/scopes.ts:231-233`), which are Bluesky *chat*
procedures — not the ATProto account (§3.1, option A).

### 1.2 The two candidate readings

**Reading A — the PDS's own account page, `https://<the user's PDS>/account`.**
Every ATProto personal data server ships a web account page. It is served by
`@atproto/oauth-provider`, which mounts it as
`router.get(/^\/account(?:\/.*)?$/, …)` and returns the account SPA
(`pds/node_modules/@atproto/oauth-provider/dist/router/create-account-page-middleware.js`,
the same file that serves `/.well-known/change-password` as a redirect to
`/account/reset-password`). Its routes are
`/account` (redirects to the signed-in account), `/account/sign-in`,
`/account/sign-up`, `/account/reset-password`, and
`/account/u/$accountId/{about,apps,devices,manage}` — with the delete flow
living under `manage`, calling `POST /delete-account-request` and
`POST /delete-account-confirm` (the client methods `deleteAccountRequest` /
`deleteAccountConfirm`, and their UI strings "Delete my account" /
"Yes, delete my account" / "Account deleted", are in
`.../oauth-provider-ui/dist/`). This is the reference account-management page
for an ATProto account, full stop, and it is the only place an ATProto account
can actually be destroyed.

**Reading B — a Roomy-owned `/account` page in app-lite.** Absent from the
tree (§1.1). Note that `https://roomy.space/account` *does* return HTTP 200,
but it is not a page: the adapter-static build serves `index.html` for every
unknown path (`netlify.toml`: `from = "/*"`, `to = "/index.html"`, `status =
200`), and every route sets `ssr = false`
(`packages/app-lite/src/routes/user/settings/+page.ts:1`), so the response is
the shared app shell with no account route behind it. A link there would drop
the user into the app's own catch-all. This reading is not supported by the
code.

### 1.3 Recommendation: Reading A, measured

Reading A is what the tree supports and what the network confirms. Measured
2026-10-13:

| URL | Result |
|---|---|
| `https://roomy.chat/account` | HTTP 200, `@atproto/oauth-provider` account page (`account-page-*.js`), `__customizationData` = `{"availableUserDomains":[".roomy.chat"],"inviteCodeRequired":true,"name":"roomy.chat PDS"}` |
| `https://bsky.social/account` | HTTP 200, same provider, Bluesky branding |
| `https://roomy.chat/.well-known/change-password` | 302 → `https://roomy.chat/account/reset-password` |
| `https://roomy.space/account` | HTTP 200, the Roomy SPA shell (Reading B — not a page) |

`https://roomy.chat` is Roomy's own PDS: it is the default value of
`PUBLIC_PDS` (`packages/app-lite/.env.example:6`), it is the origin the app's
Register tab posts `com.atproto.server.createAccount` to
(`packages/app-lite/src/lib/components/auth/LoginModal.svelte:55-61`,
`:86-96`), and it brands itself "roomy.chat PDS". So for a `.roomy.chat`
account the deletion page **is** on the developer's own website, which is
exactly the shape Guideline 5.1.1(v) asks for (§7.1). For a user who signed in
with a Bluesky or other-hosted account, the page is that PDS's, and the link
must be built per-account — the user's PDS endpoint is resolvable from their
DID document (`#atproto_pds`; SDK:
`packages/sdk/src/transport/did-resolve.ts:84-93`; appserver:
`packages/appserver/src/identity.ts:142-153`).

---

## 2. Verified starting point

### 2.1 How a Roomy account comes into existence

Two paths, both starting from the same screen
(`packages/app-lite/src/lib/components/auth/LoginModal.svelte`).

**Register.** The Register tab (`:283-289`, headed "Register for a Roomy
Account") posts directly to `PUBLIC_PDS`
(`packages/app-lite/src/lib/components/auth/LoginModal.svelte:86-96`):

```ts
}>("com.atproto.server.createAccount", {
  body: {
    email,
    inviteCode: env.PUBLIC_PDS_INVITE_CODE,
    handle: fullHandle,          // PUBLIC_PDS_HANDLE_SUFFIX appended at :82
    password,
  },
});
```

So **Roomy does create accounts in-app** — against the PDS named by
`PUBLIC_PDS` (`packages/app-lite/.env.example:6-8`), which is a build-time
`PUBLIC_*` var read through `$env/dynamic/public`. Guideline 5.1.1(v)'s trigger
condition is therefore met, and it is met literally: the reviewer can create
an account from the login screen.

Two build facts follow from where that var comes from, and both matter for
the submission:

- The Register tab is unconditionally rendered — `{#if true}` at
  `LoginModal.svelte:267`. There is no flag that can turn account creation off
  for a build; the trigger condition is structural, not configurable.
- `PUBLIC_PDS` reaches a build through the environment
  (`Dockerfile.app-lite:13-17` declares it as a build `ARG`) or through a
  gitignored `.env` (`.gitignore:41-44`). Public env for a static build is baked
  at build time into `_app/env.js` (`@sveltejs/kit`'s `generateEnvModule`), so
  the value is whatever the frontend build step ran with — which is why it
  cannot be read off the repository. **The shipping native build's PDS is
  `roomy.chat`** (§8 decision 16), so its Register tab works and 5.1.1(v)
  binds the TestFlight build. Confirm the baked value from one shipping build
  rather than by inference: the app logs the whole public env block on startup
  (`routes/+layout.svelte:71-73`), so a single run answers it. If a build ever
  shipped without it, the Register tab throws `"No public PDS defined"`
  (`LoginModal.svelte:59`) and the trigger condition would fall back to the web
  deployment.

**Sign in.** `login(handle)` (`packages/app-lite/src/lib/auth.svelte.ts:375`)
drives ATProto OAuth against whatever PDS the handle resolves to, via
`initSession` / `sdkLogin`. The app never sees a password and never holds the
account's credentials.

Either way the result is the same: **the user's identity is an ATProto DID
with a PDS the user does not get from Roomy.** Roomy holds a session, not an
account.

### 2.2 What Roomy owns, and what the user's PDS owns

| | Owned by | Deletable by Roomy? |
|---|---|---|
| The DID, its PLC entry, its handle | The user (via their PDS) | **No** — see §3.1 |
| The user's repo: `space.roomy.user.profile/self`, `space.roomy.user.block/*` | The user | Only with a `repo:` grant, and it must not (§3.4) |
| The user's OAuth grant at their PDS | The PDS | No |
| Space streams, messages, membership edges | The Roomy appserver (per space) | Yes |
| The appserver's per-user rows (read state, profiles, push, …) | The Roomy appserver | Yes |

This asymmetry is the whole design problem. Guideline 5.1.1(v) asks for "the
entire account record, along with associated personal data" (§7.1). Roomy
cannot reach half of that record, and the half it *can* reach is not the half
a user means when they say "delete my account".

### 2.3 Every per-user row the Roomy appserver holds

Four physical SQLite databases (`packages/appserver/src/db/paths.ts:9-14`; the
pool wiring at `packages/appserver/src/db/db.ts:95,101-108`). A purge has to
name every table it touches; this is that list.

**Events DB — `data/roomy-events.sqlite`.** Declared the source of truth:
*"NEVER delete or modify rows"* (`packages/appserver/src/db/eventsSchema.sql:2`).

| Table | Column | Anchor |
|---|---|---|
| `stream_events` | `user` (the signer) | `eventsSchema.sql:3-6` |
| `did_owners` | `owner` | `eventsSchema.sql:58-61` |

**Read-state DB — `data/roomy-readstate.sqlite`.** Header: *"appserver-owned
state that cannot be reconstructed from the event log"*
(`readStateSchema.sql:3-5`). Every DID-keyed table here is authored state.

| Table | Column | Anchor |
|---|---|---|
| `user_space_membership` | `user_did` | `readStateSchema.sql:31-38` |
| `space_order` | `user_did` | `:47-52` |
| `read_positions` | `user_did` | `:57-63` |
| `user_thread_activity` | `user_did` | `:84-90` |
| `push_subscriptions` | `user_did` | `:114-123` |
| `push_user_default` | `user_did` | `:129-133` |
| `push_preferences` | `user_did` | `:136-142` |
| `user_room_participation` | `user_did` | `:146-151` |
| `notification_state` | `user_did` | `:159-168` |
| `feature_flag_assignments` | `user_did` | `:185-189` |
| `bridge_token_grants` | `grantor_did` | `:205-211` |
| `pro_role_grants` | `did` | `:221-224` |
| `user_oauth_grants` | `user_did` | `:237-241` |
| `user_scope_intents` | `user_did` | `:254-258` |
| `user_blocks` | `user_did` (and `blocked_did`) | `:287-295` |
| `user_block_fetches` | `user_did` | `:301-305` |

`user_blocks` and `user_block_fetches` (read-state schema v15,
`readStateVersions.ts:159`) landed after this plan's first revision and are
listed here so the purge cannot miss them. Both are the DID's own cached block
set, so both are purged — but note the **second direction**: a row where
`blocked_did = <did>` is somebody *else's* row recording their block on the
deleted user (`queries/userBlocks.ts:179` reads the reverse set through
`idx_user_blocks_blocked`). It lives under a different `user_did` and is not
this purge's to delete; it is also a cache of a record still in that user's
repo, so leaving it is correct. The purge filters `user_did = <did>` only, and
must never delete on `blocked_did` — doing so would delete other people's rows.

**Global DB — `data/global.sqlite`.** Header: *"derived data: it can be
regenerated by replaying the local event log"*
(`packages/appserver/src/db/schema-global.sql:14-15`) — except for the two
tables noted below.

| Table | Column | Anchor | Notes |
|---|---|---|---|
| `edges` | `head` (user DID), `label in ('joinedSpace','leftSpace')` | `schema-global.sql:35-41` | derived |
| `profiles` | `did` | `:51-56` | *"authoritative"*; partly fetched over HTTP |
| `entity_space` | `entity_id` (a DID for user rows) | `:70-73` | derived |
| `mentions` | `did` | `:124-132` | derived |
| `space_federations` | `requested_by_did`, `decided_by_did` | `:185-197` | cross-space registry |
| `federation_receiver_permissions` | `grantee` where `kind = 'user'` | `:214-230` | cross-space registry |

The two federation tables are the one global pair that is neither derived from
the event log nor the user's own state. Their DID columns record who
*administered* a federation request and who a grant was issued to
(`statementRouting.ts:11-31` routes them to the global DB). §3.3 decides both:
`federation_receiver_permissions` rows with `kind = 'user'` are deleted, and
the two admin-audit columns on `space_federations` are retained as the
*space's* history rather than the user's profile data.

**Per-space DBs — `data/spaces/<spaceDid>.sqlite`.** Header: *"Derived from
schema.sql"* (`schema-space.sql:2-3`). User DIDs appear in:

| Table | Column | Anchor |
|---|---|---|
| `entities` | `id` (did or ulid) | `schema-space.sql:47-54` |
| `edges` | `head`/`tail` (`member`, `admin`, `author`, `reply`, `forward`) | `:83-93` |
| `comp_user` | `did` | `:144-150` |
| `comp_info` | `entity` (a DID on user rows) | `:163-168` |
| `comp_page_edits` | `user_id` | `:179-187` |
| `comp_reaction` | `user` | `:248-255` |
| `member_roles` | `user_id` | `:293-298` |
| `comp_bans` | `user_did` | `:312-319` |
| `comp_invite` | `created_by_did` | `:322-330` |
| `room_activity` | `recent_authors` (JSON `{did, ts}`) | `:408-414` |
| `call_participants` | `did` | `:434-441` |

**Derived, and therefore regenerable:** the per-space `entities`, `edges`,
`comp_user`, `comp_info`, `comp_content`, `comp_reaction`, `comp_page_edits`,
`member_roles`, `comp_bans`, `comp_invite`, `room_activity`,
`call_participants`, `room_access`, `room_access`/`room_activity` projections,
and the global `edges`, `entity_space`, `mentions`, `space_stats`, and
`search_backfill_*`. **Not regenerable:** the whole read-state DB (by its own
header), `stream_events` and `did_owners`, and the global `profiles` rows for
DIDs whose records are gone.

### 2.4 What already exists that the flow can reuse

- **A self-scoped procedure idiom.** `parseUserDid(auth)`
  (`packages/appserver/src/xrpc/authGuards.ts:30`) returns the caller's DID or
  `null` for anonymous, and the handler threads that DID into every `WHERE`.
  The canonical instance is
  `handlers/space.roomy.push.unregisterSubscription.ts:23-37`; the same shape
  appears in `reorderSpaces`, `revokeBridgeToken`, `recordScopeGrant`,
  `setPreferences`, `updateSeen`, `createProCheckout`. There is **no**
  `requireSelf` helper — no guard compares a caller DID to a row's owner DID
  — so the new handler must filter for itself.
- **Per-endpoint push removal.** `deleteSubscription` →
  `"delete from push_subscriptions where user_did = ? and endpoint = ?"`
  (`queries/pushSubscriptions.ts:64`), reached from
  `space.roomy.push.unregisterSubscription`. It removes **one device's**
  endpoint; nothing server-side removes a DID's rows across all devices, and
  `push_preferences` / `push_user_default` have no delete-by-DID path at all.
- **Message deletion, author-gated.** `space.roomy.message.deleteMessage.v0`
  is emitted as the author (`auth/writeAuth.ts:556-575` — author *or* space
  admin), one event per message, batched into a single `sendEvents` call up to
  50 events (`handlers/space.roomy.space.sendEvents.ts:30`,
  `mutations/message.ts:238-253`). Phase 1 does not use this (§6.2); it is the
  mechanism any future message deletion would be built on.
- **A teardown that already does the client half.** `logout()`
  (`lib/auth.svelte.ts:658-715`) clears the persisted cache
  (`lib/client.ts:202-205`), clears this device's push subscription
  (`lib/push.svelte.ts:307-330`), revokes the session, resets every reactive
  field, and reloads. The delete flow ends by calling it.
- **A single link router.** `routeLinkClick`
  (`lib/link-routing.ts:79-130`) classifies any off-origin `http(s)` URL as
  `external` (`:129`); the one capture-phase listener
  (`lib/external-link-handler.ts:60-100`, installed from
  `routes/+layout.svelte:113`) hands it to the OS. The shell mirrors the rule
  for navigations no click produces
  (`src-tauri/src/navigation.rs:27-37`). §3.6.
- **The membership list the purge needs to fan out over.**
  `selectUserSpaces(readStateDb, userDid, includeLeft = true)`
  (`queries/userSpaceMembership.ts:130-145`) returns every `(space_did,
  state)` row for a DID — the only DID-indexed list of a user's spaces.
- **A flag registry, read by every client surface.**
  `packages/appserver/src/featureFlags.ts:21-67`, served through
  `space.roomy.getFlags` and read by `createFeatureFlagsQuery`.

### 2.5 Absent, and required

- **No account-deletion concept anywhere.** No XRPC, no event, no table, no
  UI, no plan. Searches for `deleteAccount`, `account deletion`, `deactivate`,
  `purge`, `anonymis|anonymiz`, `erase` across `packages/appserver` and
  `packages/app-lite` return only the Bluesky *chat* scope tokens, one
  aspirational line in `docs/plans/voice-chat-plan.md:38`, and unrelated
  soft-delete flags.
- **No `requireSelf` / ownership guard** (§2.4).
- **No sweep that deletes rows for a DID.** Every existing user-scoped delete
  is one row, one endpoint, one message, one room, or one flag key
  (`queries/featureFlags.ts:115,140` deletes by `flag_key`, not by DID).
- **No reaper for accounts whose PDS account is already gone.** Nothing in the
  appserver subscribes to identity events or checks whether a DID still
  resolves as a live account.

---

## 3. The deletion model

### 3.1 The three options

**Option A — delete the ATProto account itself, from inside the app.**
Rejected, on evidence. The PDS's own deletion endpoints refuse OAuth
credentials outright. `com.atproto.server.requestAccountDelete` is registered
with

```js
auth: ctx.authVerifier.authorization({
    checkTakedown: true,
    scopes: ACCESS_FULL,
    authorize: () => {
        throw new ForbiddenError('OAuth credentials are not supported for this endpoint');
    },
}),
```

(`pds/node_modules/@atproto/pds/dist/api/com/atproto/server/requestAccountDelete.js:19-25`;
the same `authorize` refusal is on the sibling
`deactivateAccount.js:6-12`). And `com.atproto.server.deleteAccount` is
password + emailed-token only — `verifyAccountPassword`,
`assertValidEmailToken(did, 'delete_account', token)`
(`.../server/deleteAccount.js:31-61`). That is deliberate: the flow exists so
the account holder, not a client, destroys the account. A client holding an
OAuth session cannot drive it, by design.

> The installed dependency is `@atproto/pds@0.5.34` (`pds/package.json:8`
> declares `^0.5.2`). It is not vendored into git — `pds/node_modules` is
> ignored — so this is a citation to a dependency version, not to the tree.

`chat.bsky.actor.deleteAccount` is **not** an exception. It is in the DM tier
(`packages/app-lite/src/lib/scopes.ts:232`) and is an OAuth-scoped procedure,
but it deletes the caller's Bluesky *chat* account on the chat AppView. The
ATProto account — the DID, the repo, the PDS login — is untouched by it.

**Option B — purge the Roomy-side rows, then hand off to the PDS account
page.** Roomy deletes everything it holds for the DID and signs the user out;
the user finishes by deleting the ATProto account at
`https://<their PDS>/account`, reached by a direct link from the same flow.

**Option C — link out only.** A single link from settings to the PDS account
page, and no Roomy-side purge. Cheapest, and satisfies "include a link
directly to the page where they can complete the process". It leaves the
appserver's rows for the DID in place forever, which is not what the user
means, and which the guideline's own FAQ answers directly: the content a
person provided is expected to go with the account (§7.1).

### 3.2 Decision: Option B

Roomy purges what it holds; the PDS destroys the account. Two reasons, in
order:

1. **Correctness.** Option C leaves the appserver answering for a DID whose
   account is gone — `getSpaces` would still list their spaces, `profiles`
   would still return their name, `push_subscriptions` would still hold
   device tokens. That is a lie about a deletion that the user believes
   happened.
2. **Honesty about the boundary.** Option B is the only option that makes the
   two halves explicit and gives the user a place to finish. The flow's copy
   must say, in the same breath, what Roomy deleted and what only the PDS can.

The cost Option B accepts: the ATProto account survives until the user
completes the hand-off, and Roomy has no way to verify that they did. §6.3
(P3) is where that is closed.

### 3.3 What the purge clears

Everything in §2.3 that is keyed by, or contains, the caller's DID, in four
groups:

1. **Read-state, one DID-scoped statement per table** — the 16 tables in
   §2.3, including all of the DID's `push_subscriptions` rows (every device,
   not just the current one), `user_oauth_grants` / `user_scope_intents`, and
   the pair of block-cache tables. Every one of these filters
   `user_did = <did>` / `grantor_did = <did>` / `did = <did>`; **none may
   filter on `blocked_did`** (see §2.3).
2. **Global** — `edges` rows with `head = <did>` and
   `label in ('joinedSpace','leftSpace')`; the `profiles` row; `mentions` rows
   with `did = <did>`; `entity_space` rows for the DID as `entity_id`;
   `federation_receiver_permissions` rows with `grantee = <did>` and
   `kind = 'user'`. The two admin-audit columns (`space_federations.requested_by_did`
   / `decided_by_did`) are retained, matching how the plan treats the other
   record-keeping rows: they say who administered a *space's* federation, which
   is the space's history rather than the user's profile data (§2.3).
3. **Per-space**, fanned out over `selectUserSpaces(readStateDb, did, true)`
   (§2.3 for every anchor). Two mechanisms, and the difference matters:
   - **Cascade.** Deleting the user's `entities` row removes every row holding
     an FK to it with `on delete cascade` — `pragma foreign_keys = on`
     (`schema-space.sql:31`), FKs at `:90-91` (per-space edges),
     `:108` (comp_space), `:126` (comp_room), `:138` (comp_discord_origin),
     `:154` (comp_content), `:164` (comp_info — the user's profile row),
     `:183` (comp_page_edits, through `entity`), `:190` (comp_comment),
     `:200`, `:212`, `:225`, `:234`, `:241` (the embed tables), `:249-250`
     (comp_reaction), `:313` (comp_bans), `:323` (comp_invite). Deleting a
     `comp_page_edits` row in turn cascades `comp_comment` through
     `comp_page_edits(edit_id)` (`:191`).
   - **Explicit.** Rows with no FK at all, which any entities-first cascade
     simply misses: `comp_page_edits.user_id` (`:186` is set below),
     `member_roles.user_id` (`:294`), `comp_bans.user_did` (`:314`),
     `comp_invite.created_by_did` (`:325`), `call_participants.did` (`:436`),
     `room_activity.recent_authors` (`:414`).
   - **The order this forces.** `comp_user.did` is declared
     `references entities(id)` **without** `on delete cascade` (`:147`), so the
     default `RESTRICT` applies and the `comp_user` row must be deleted
     **before** the `entities` row, or the whole per-space pass aborts on an FK
     violation. Verified against the real schema: deleting `entities` first
     fails with `FOREIGN KEY constraint failed (19)` even when the `comp_user`
     delete is issued in the same transaction.
   - **The cascade also strips attribution from retained content.** `edges`
     holds `(head = <messageId>, tail = <authorDid>, label = 'author')`
     (`:83-93`; written by the SDK's CreateMessage at
     `packages/sdk/src/schema/events/message.ts:58-72` and by
     `link.ts:49-58` / `space.ts:82-89` for system messages). `head` and `tail`
     both cascade from `entities`, so deleting the user's entity removes the
     `author` edge from **every message they ever wrote** while leaving the
     message entity and its `comp_content` body intact. Measured on the real
     schema with the real read SQL (`selectMessages.ts:220-260`): the row still
     comes back, `author_did` is NULL, and the DTO maps that to `authorDid: ""`
     (`selectMessages.ts:634`). The `system` flag is computed as
     `authorDid === stream_id` (`:638`), which null fails, so it does not
     become a system message either. **The message renders as an ordinary
     bubble with no name, no avatar, and a `/user/` link.** That is the state
     Phase 1 ships in, and it is neither "deleted" nor "retained as-is" — see
     §3.8 for the copy that has to describe it.
     The same cascade removes the user's `member`/`admin` edges (`space.ts:46-66`,
     `:346-362`) and every `comp_reaction` row they left **on other people's
     messages** (`comp_reaction.user` cascades at `:250`) — a like the user
     gave is destroyed, the message they gave it to is untouched.

**Ordering within the per-space pass is load-bearing.** `comp_user` must go
first. Everything else can follow in any order, because the rows that have no
FK are deleted or cleared explicitly and the ones that do are removed by the
`entities` cascade at the end.

**The replay interaction, which the tombstone must get right.** `CreateMessage`
emits `ensureEntity(streamId, user)` alongside the `author` edge
(`packages/sdk/src/schema/events/message.ts:55-72`). If the tombstone blocks
the user's `entities` insert but not the `author` edge insert, a replay hits
the FK and the whole per-event transaction rolls back — counted as an
`applyError` (`materialization/applyBatch.ts:379-386`), so the space's
materialisation errors per event instead of silently resurrecting rows. Gating
the `entities` insert alone is therefore both insufficient and harmful; the
tombstone has to suppress **both statements as a unit**, which is a
materialiser-level change rather than a statement-routing one.
4. **Events DB — nothing.** `stream_events` is append-only by declaration
   (`eventsSchema.sql:2`) and `did_owners` records who may rotate a space's
   stream key, not who owns the user's account. Deleting event rows would
   break every space that has already materialised them. The purge records
   the DID in a tombstone (below) and leaves the log alone.

**The tombstone.** The purge writes one row to a new read-state table,
`deleted_accounts(did, deleted_at, reason)` — *not* a list of what was
deleted, just the fact that it was. It exists for one reason: the derived DBs
are regenerable from the event log (§2.3), and a replay would otherwise
resurrect the user's `entities`/`edges`/`profiles` rows from events that are
still in `stream_events`. Every materialiser that writes a user-keyed row
must consult it, exactly as `statementRouting.ts` consults table names today.
Without it the purge is undone by the next re-materialisation, which is the
one failure mode this design cannot tolerate.

### 3.4 What the purge must NOT touch

- **The user's own repo.** `space.roomy.user.profile/self` and any
  `space.roomy.user.block/*` records live in the user's repository
  (`packages/app-lite/src/routes/user/[user]/+page.svelte:191-266`,
  `packages/app-lite/src/lib/mutations/blocks.ts:83-102`). They are the user's
  data, on the user's PDS, and the PDS's own account deletion removes them.
  Roomy issuing `com.atproto.repo.deleteRecord` against them would be a
  destructive write to someone else's account on a path they did not ask for.
- **Anything the user did not own.** Other members' messages, other members'
  profiles, and the space's own configuration are not the departing user's to
  delete.
- **`comp_page_edits` rows are retained; only their attribution is cleared.**
  Decided (§8 decision 11; this was §9 Q1b). A page edit is a version of a
  *collaborative document*: `comp_page_edits.data` is the document blob and
  `comp_page_edits.edit_id` is what `comp_comment.version` points at
  (`schema-space.sql:179-196`). Deleting the row does not merely drop an
  attribution — it cascades the comments anchored to that revision
  (`:191`), rewrites the page's history, and can break a document other people
  are still editing. So the purge **keeps every edit row and blanks its
  `user_id`**, which is the attribution-only removal the decision asks for.

  Two consequences the implementation has to handle:

  1. **`user_id` is `not null` with no default** (`:186`). The scrub is
     `update comp_page_edits set user_id = '' where user_id = <did>`, not
     `set user_id = null`. Verified against the real schema: with the user's
     entity deleted and the scrub applied, both edit rows and the anchored
     comment survive and no row names the DID any more.
  2. **`user_id` has no foreign key**, so the scrub survives the `entities`
     cascade — unlike the `entity` column on the same table (`:183`), which
     still cascades when the *page* is deleted. A comment on a deleted page
     goes with the page, which is the pre-existing behaviour and not a
     deletion concern.

  Ordering: the scrub is independent of the `entities` delete, so it can run
  anywhere in the per-space pass.

  Note the current state of the feature — this is a forward-looking decision,
  not a live one. `comp_page_edits` is **write-only in the appserver today**:
  the only statement anywhere that touches the table is the SDK's EditPage
  materialiser (`packages/sdk/src/schema/events/page.ts:32`), and there are no
  `space.roomy.page.*` handlers registered at all. Nothing reads the table, so
  blanking `user_id` changes no current response. The decision is recorded
  because the retention semantics are what a future page-history surface (the
  removed `PageHistory`/`getHistory` query, per
  `packages/appserver/docs/livequery-inventory.md:30`) would rest on, and
  because the alternative silently breaks it.
- **`did_owners`.** It maps a space stream DID to the DID permitted to rotate
  that stream's key (`streams/keys.ts:14-34`, written from `streams/did.ts:45`
  with the creating admin). It is not user-account data, and a user who
  created a space leaving it un-rotatable would break the space.
- **`space_federations.requested_by_did` / `decided_by_did`.** Retained, unlike
  the `federation_receiver_permissions` rows §3.3 deletes. They are an audit
  trail of who asked for and who approved a *space's* federation, which belongs
  to the space's history rather than to the departing user's profile; and a
  request whose requester is gone would otherwise read as though nobody made
  it. The distinction is between a DID as an *actor* on a shared object (kept)
  and a DID as the *subject* of a grant (purged) — §2.3 has the detail.

### 3.5 The rows and content that need an explicit answer

These look like the user's but are load-bearing for somebody else, or are
shared content the account does not own. None is simply "retained": some are
kept untouched, some are deleted as part of a larger cleanup, and one — the
user's own messages — is kept *with its attribution removed*, which is neither.
The disclosure must name all of them. Guideline 5.1.1(v) asks for exactly this
("let people know what information will and won't be retained"):

- **The user's own messages keep their content and lose their author.** Phase 1
  does not delete them (§6.2), and the community-owned-content position means
  it is not planned to. But the `author` edge cascade in §3.3 still strips the
  attribution, so the *observable* outcome is a message with a body and no
  author — not the "your messages remain" the earlier copy said. The copy in
  §3.8 has to describe the real outcome, and Phase 1's exit criteria have to
  accept it. If a future phase wants the attribution *retained* instead
  (a tombstone author reading "deleted account"), that is the opposite choice
  and needs §3.3's cascade deliberately worked around — it is not what this
  plan ships.
- **`bridge_token_grants`** (`readStateSchema.sql:205-211`). One row per
  grantor DID, powering a guild↔space bridge up to a granted capacity. The
  schema is explicit that *"`spent_at` is set when the bridged guild's member
  count exceeds 100 and is PERMANENT — a spent grant can neither be revoked nor
  re-granted"* and that *"the grant row persists across subscription
  lapses/cancellations"* (`readStateSchema.sql:196-204`). Deleting it would
  take the bridge out from under a space that is still using it.
- **`pro_role_grants`** (`readStateSchema.sql:221-224`). The reconcile sweep's
  ownership record, *"so it can remove a lapsed subscriber WITHOUT clobbering a
  manually-assigned member who is not a subscriber"*
  (`readStateSchema.sql:215-220`); the sweep that acts on it is
  `billing/proRoleReconcile.ts:120-178`. The purge deletes the row, and only
  after emitting the corresponding `removeMemberRole` — otherwise the sweep
  permanently loses the ability to clean up that DID's role.

### 3.6 The hand-off link

**The URL.** `https://<pds-endpoint>/account`, where `<pds-endpoint>` is the
account's `#atproto_pds` service from its DID document
(`packages/sdk/src/transport/did-resolve.ts:84-93` returns it with any
trailing slash stripped, so `/account` appends directly). Measured live for
both common values: `https://roomy.chat/account` (Roomy's own PDS,
`packages/app-lite/.env.example:6`) and `https://bsky.social/account`.

**Do not link to `https://roomy.space/account`.** It answers 200 with the app
shell (§1.2), *and* `https://roomy.space/*` is claimed as an app link
(`src-tauri/tauri.conf.json:59-68`), so in the shell that link would deep-link
straight back into the app. The link must be built from the resolved PDS
origin, never from the app's own public origin
(`packages/app-lite/src/lib/config.ts:40` `publicWebOrigin`).

**No per-callsite handling.** An off-origin `https` URL is classified
`external` by `routeLinkClick` (`lib/link-routing.ts:129`) and opened in the
OS browser by the single installed listener (`lib/external-link-handler.ts:60-100`);
`AGENTS.md:294-306` states the table and forbids site-local handling. A plain
`<a href={pdsAccountUrl}>` is the whole implementation. Two consequences worth
writing down rather than discovering:

- The web build does nothing special — `routeLinkClick` returns `default`
  outside the shell (`:118`) and the browser opens the link normally.
- A navigation that no click produces is governed by
  `src-tauri/src/navigation.rs:27-37`, so the flow must not
  `window.location.assign` to the PDS page. It must be a link.

### 3.7 Auth and permission model

One new authenticated procedure, `space.roomy.user.deleteAccount`, following
the self-scoped idiom of §2.4: `parseUserDid(auth)`, 401 when anonymous, and
the caller's own DID as the only value any statement filters on. It takes **no
parameters** — there is nothing to parameterise, and a body that could name a
DID is a body that could be aimed at someone else. A user may only ever delete
themselves; there is no admin path, deliberately (a space admin has no
standing over a user's account, only over their space — that is `banAccount`,
which already exists).

### 3.8 The copy

The flow must state, before the user confirms:

- What Roomy deletes: the account's Roomy-side data — membership and join
  state, read positions, notification and push settings and every device
  registration, profile cache, mentions, block cache, and role grants.
- What Roomy does not delete: the ATProto account itself (with the link that
  does), the retained `bridge_token_grants` row, and page-edit history, which
  stays with the page it belongs to and merely loses the user's name. §3.5 says
  why for each.
- **What happens to the user's messages, in the terms the user will actually
  observe.** This is the sentence the earlier draft got wrong. Their messages
  stay in the spaces they were in — Roomy treats space content as
  partly community-owned, and Phase 2 is not planned (§6.2) — but Roomy
  removes the account's name, avatar and profile from them. So the honest copy
  is "**your messages stay in the spaces you posted them in, and will no
  longer show your name or avatar**", not "your messages remain", and not
  "your messages are deleted". A user who wants the text gone has the ordinary
  per-message delete.
- What happens to billing: Roomy Pro is billed through Polar, not Apple, and
  the iOS build does not advertise subscriptions in-app. If a subscription
  exists (bought outside the app), state that canceling or refunding is a
  separate step taken at the subscription page. Guideline 5.1.1(v) asks the app
  to say so explicitly; the exact copy is §9 Q3.

---

## 4. Write path: `space.roomy.user.deleteAccount`

### 4.1 The shape (one NSID, six registration sites)

The repo's convention for a new procedure is six edits, and CI enforces two of
them:

| Site | File |
|---|---|
| Handler | `packages/appserver/src/handlers/space.roomy.user.deleteAccount.ts` |
| Router | `packages/appserver/src/appserver.ts` — beside `:465-474` (`space.roomy.user.*`) |
| SDK schema | `packages/sdk/src/schemas/procedures/deleteAccount.ts` + `index.ts` |
| SDK registry | `packages/sdk/src/transport/registry.ts:166-243` (`PROCEDURE_SCHEMAS`) |
| Client scope list | `packages/app-lite/src/lib/scopes.ts:87-138` (`APPSERVER_RPCS`) |
| Docs prose + registry | `packages/docs/src/lib/endpoints/prose.ts` + regenerated `nsids.generated.json` |

The docs pair is not optional: `packages/docs/scripts/check-registry.ts`
regenerates the NSID list from the router and fails the build if the committed
`nsids.generated.json` is stale **or** if any registered NSID lacks prose.

### 4.2 The scope, and the ship order that cannot be skipped

`APPSERVER_RPCS` entries become `rpc:<nsid>?aud=*` tokens
(`packages/app-lite/src/lib/scopes.ts:209`) inside `BASE_SCOPES` (`:187-210`),
which is `base` — carried by **every** session and every requestable tier.

That means a new NSID enters the OAuth ceiling and the login request at once,
and it must already be registered on the HappyView API client or **every login
fails for every user** — HappyView rejects the whole granted set if one token
is unknown, surfacing as `OAuthCallbackError: Failed to register session`
(`scopes.ts:20-36`). `scripts/check-oauth-scopes.mjs:57-69` fails the build
when a requestable tier contains a token still listed in `UNREGISTERED_SCOPES`
(`scopes.ts:178-181`) — and since the new token lands in `base`, listing it as
unregistered *also* fails. There is no code-only ordering.

**The order that works, and it starts out of band:**

1. Register `rpc:space.roomy.user.deleteAccount?aud=*` on the deployed
   HappyView API client (`PUT /admin/api-clients/{id}`).
2. *Then* merge the code that adds the NSID to `APPSERVER_RPCS`.

`AGENTS.md:272-292` states this procedure for scope additions generally; this
plan is its first case where the scope lands in `base` rather than in a
deferrable tier.

A second, narrower option exists and was considered: put the
new token in a `DEFERRED_SCOPE_SETS` tier plus `UNREGISTERED_SCOPES` (the shape
`blocks` and `voice` already use, `scopes.ts:314-317`), and have the delete
flow request it on demand through the consent dialogue. That is more code and
one more consent screen for a user who is leaving. **Decided: the `base` route,
registered first** (§8 decision 12; this was §9 Q2).

### 4.3 Handler behaviour

```
1. userDid = parseUserDid(auth);            // 401 when null
2. rows = selectUserSpaces(readStateDb, userDid, true)   // every space, incl. left
3. insert into deleted_accounts (did, deleted_at, reason)  // tombstone, first
4. for each space in rows: openSpaceDb(space).run(<per-space writes, §3.3>)
   // includes `update comp_page_edits set user_id = ''` — attribution only
5. openGlobalDb():    delete edges/profiles/mentions/entity_space/
                     federation_receiver_permissions(kind='user') for userDid
6. openReadStateDb(): delete the 16 tables of §2.3 for userDid
7. emit removeMemberRole for the DID in the Roomy Space (pro_role_grants, §3.5)
8. emit invalidation signals for space.roomy.space.getSpaces and
   space.roomy.space.getMetadata, scoped to the caller
9. return void
```

Three properties this must have:

- **Idempotent.** A second call after the first is a no-op, not an error.
- **Tombstone first.** Steps 3 precede 4–6 so that a crash mid-purge leaves the
  DID marked, and the next boot (or the next call) finishes the job rather than
  letting a replay resurrect the rows.
- **Scoped invalidation.** Step 8 mirrors `leaveSpace`
  (`handlers/space.roomy.space.leaveSpace.ts:118-140`): emit directly for the
  caller rather than waiting on the async materialiser, so the race the HTTP
  response would otherwise lose is closed. `affectedUser` is the caller
  (`invalidation/types.ts`), not a broadcast.

### 4.4 Failure modes the handler must name

- **The per-space fan-out is N round-trips across N workers.** Each
  `openSpaceDb(spaceDid)` is a different pool worker
  (`db/pool.ts:109-115` hashes a space to a worker). For a user in many spaces
  this is the whole latency of the request. Phase 1 bounds it by doing the
  read-state and global work first (both single-DB) and treating the per-space
  pass as best-effort with a per-space retry recorded against the tombstone.
- **A failed per-space pass must not fail the request.** The user's account is
  theirs; an unreachable space must not block their deletion. The tombstone is
  the record of what is still owed.
- **The event log is not rewritten** (§3.3), so a full re-materialisation from
  scratch is the one path that can resurrect rows the tombstone does not reach.
  Every user-keyed materialiser must consult `deleted_accounts`; that is a
  cross-cutting change and is called out in §6.1 as an acceptance criterion,
  not as an afterthought.
- **The read path re-creates the `profiles` row, and the tombstone must cover
  it too.** Gating only the materialisers is not enough, because the global
  `profiles` row is also written on read.
  `handlers/space.roomy.user.getProfile.ts` calls `insertProfilesWithExtras`
  at four sites — `:112` (PDS record), `:155` (HappyView record), `:200`
  (Bluesky fallback) and `:244` (inside `hydrateHandle`) — and
  `queries/profileStore.ts` does the same from a detached hydration kicked off
  by *any* message or member list that renders the DID
  (`startHydration` → `hydrateMissingProfiles` → `insertProfilesWithExtras`,
  `:288`, `:336`). A single `getProfile` call, or one room page rendered by
  anyone else while the DID is still cached in their client, puts the row back
  — and it is not confined to the deleted user's own traffic.
  `writeGlobalProfile` (`materialization/profiles.ts:464-521`) is the single
  choke point every one of these goes through — `insertProfiles` (`:568-572`),
  `insertProfilesWithExtras` (`:591-600`) and `writeSetUserProfileToGlobal`
  (`:529-570`) all end at it (as does `ensureProfilesRoomyFirst`, `:333-348`,
  indirectly) — so the guard belongs there, not scattered across the handlers.
  §6.1's exit criterion "`space.roomy.user.getProfile` no longer answers from
  the materialised row" is only testable once this is in place: without it the
  handler happily re-materialises the row from the PDS/HappyView and answers
  from it.
- **Phase 1 accepts a partial purge.** Because the per-space pass is
  best-effort (§4.4 above) and the `author`-edge cascade is the only thing that
  touches the user's messages, a space that is unreachable at delete time
  keeps both the `entities` row and the message attribution until the retry
  lands. The tombstone is what makes that state recoverable rather than
  permanent; the disclosure should not promise per-space atomicity.

---

## 5. Client surface

A new settings route `/user/settings/account`, a sibling of
`notifications` / `subscription` / `scopes`:

- **Route.** `packages/app-lite/src/routes/user/settings/account/+page.svelte`
  + `+page.ts` (`export const ssr = false;`, matching
  `routes/user/settings/+page.ts:1`).
- **Nav entry.** One `Button` in the settings sidebar, beside the Access entry
  (`routes/user/settings/+layout.svelte:131-140`).
- **Page name.** One case in the `settingsPageName` switch
  (`routes/user/settings/+layout.svelte:30-44`), so the navbar reads "Account"
  rather than "Settings".
- **Entry point.** `SidebarUserCard.svelte:163` already navigates to
  `/user/settings`; the new page is one click further, which is what "typically
  included in the app's account settings" asks for (§7.1).
- **Gating.** A new `account-deletion` entry in `FEATURE_FLAGS`
  (`featureFlags.ts:21-67`), read through `createFeatureFlagsQuery`, matching
  how `access-settings` gates its page (`routes/user/settings/scopes/+page.svelte:24-27`).
  Note for the submission: the flag must be **globally enabled** for the build
  the reviewer sees, or the option is invisible and the guideline is unmet.
- **The confirm flow.** Explain (§3.8) → confirm → `px().procedure(
  "space.roomy.user.deleteAccount", {})` → `logout()` → the PDS account page
  opened as a link (§3.6).
- **`logout()` is not part of the deletion.** It is the session teardown the
  user sees. If the procedure fails, the flow must say so and keep the session,
  not sign the user out of an account that still exists.
- **The subscription notice is conditional on a subscription existing.** The
  iOS build does not advertise subscriptions (§8 decision 13): the
  `pro-subscription` flag gates the settings entry and the subscription page's
  content (`routes/user/settings/subscription/+page.svelte:47-52`, `:170-176`),
  and the App Store submission ships it off. But the account page must still
  tell a *subscribed* user that their billing continues, because a subscription
  bought outside the app survives the deletion and keeps charging them.
  Two consequences the implementation has to respect:

  1. **Do not gate the notice on the flag.** `getMembershipStatus`
     (`space.roomy.user.getMembershipStatus`) is a plain authenticated query
     that resolves live from Polar, and the page's script calls it
     unconditionally — the flag only decides what renders. Reading it from the
     account page is therefore possible regardless of the flag, and the
     decision is to show the notice whenever `isPro` is true.
  2. **The notice is per-user state, not per-build.** A user who has no
     subscription sees nothing; a user who has one sees the notice even in the
     build where the feature is otherwise hidden. That asymmetry is the point —
     the guideline asks the app to disclose billing, and a user with no
     subscription has no billing to disclose.

---

## 6. Phasing

Each phase is independently shippable. Phase 1 is the TestFlight-acceptable
minimum.

### 6.1 Phase 1 — the account page, the purge, and the hand-off

**Ships:** the settings route and nav entry; the `account-deletion` flag; the
`space.roomy.user.deleteAccount` procedure with its SDK schema, lexicon, route,
docs prose and regenerated registry; the `deleted_accounts` tombstone table
plus the guard that makes it authoritative — **in the materialisers *and* in
`writeGlobalProfile`** (§4.4); the per-space purge including the
`comp_page_edits` attribution scrub; the disclosure copy; the conditional
subscription notice (§5); the hand-off link.

**Blocked on, before the code merges:** the HappyView scope registration
(§4.2).

**Done means, observable:**

- On device: Settings → Account → Delete account → confirm → the app signs
  out, and the platform browser opens the PDS's account page for the correct
  PDS host.
- After the call, `space.roomy.space.getSpaces` returns no spaces for the DID,
  and no `push_subscriptions` row for the DID survives.
- `space.roomy.user.getProfile` does not answer from a materialised row **and
  does not put one back**. Both halves are required: the read path re-writes
  the row (§4.4), so the test is a `getProfile` call after the purge followed
  by a direct read of the global `profiles` table, not the response alone.
- The user's messages in a shared space are still readable, with their content
  intact and no author identity attached (`author_did` null → `authorDid: ""`).
  That is the expected outcome, not a regression to fix in Phase 1 — §3.3 and
  §3.5 explain it, and §3.8's copy describes it to the user.
- Page-edit rows for the DID survive with `user_id` blanked, and the comments
  anchored to those edits are still present.
- A re-materialisation from the event log does **not** resurrect the DID's
  `entities`/`edges`/`profiles` rows.
- A second call is a no-op.

**Not yet:** message deletion (§6.2), deferral (§6.3).

**The two CI gates that must pass, and what they enforce.** Both already run
on every pull request (`.github/workflows/ci.yml`):

- `node packages/app-lite/scripts/check-oauth-scopes.mjs` (`ci.yml:288`) —
  fails if any requestable tier asks for a token listed in
  `UNREGISTERED_SCOPES`, and if `build-prod.sh` stops deriving its scope from
  `FULL_SCOPE_CEILING`. **Phase 1 cannot merge before the HappyView
  registration, and that is by design** (§4.2): the check is what makes the
  out-of-band step impossible to skip.
- `pnpm --filter docs check:registry` (`ci.yml:330`, via
  `packages/docs/package.json:11`) — fails if `nsids.generated.json` is stale
  or if the new NSID has no prose. Regenerate and commit, do not hand-edit.

Beyond those, the appserver suite (`bun test --cwd packages/appserver
--isolate`, `ci.yml:117`) must report `0 errors`, not merely `0 fail` — the
`openDb()` smoke test's fire-and-forget init surfaces a broken DB as an
unhandled rejection between tests.

### 6.2 Phase 2 — the user's own content in shared spaces (NOT PLANNED)

**Decided: not planned for the near term** (§8 decision 14). Phase 1 is
sufficient for App Store review, and Roomy's position is that content in a
space is partly community-owned — a message is a contribution to a shared
conversation, and an author leaving does not necessarily take it back. This
section is kept as the design of record if that position ever changes; it is
not a commitment and nothing in Phase 1 should be built as a stepping stone to
it.

Two things follow for Phase 1, and both are load-bearing:

- **The copy must not promise it.** §3.8 states the real outcome — the messages
  stay, the name and avatar come off — rather than saying "deletion is
  complete". Guideline 5.1.1(v)'s FAQ does say *"Does the content provided by a
  person need to be deleted in apps that display and share user-generated
  content? Yes."*, so this is the one clause Phase 1 knowingly does not fully
  satisfy. §7.1 records that honestly rather than claiming the mapping, and
  §7.2's review notes have to disclose it. This is a judgement call about the
  product, not an oversight, and it is the single most likely thing a reviewer
  could push back on.
- **Phase 1 does not have to build for it.** The tombstone, the purge and the
  handler stay as specified; none of them needs a message-deletion seam or a
  job queue it would not otherwise need.

If it is ever built, the shape would be:

- The author's own messages are deleted by emitting
  `space.roomy.message.deleteMessage.v0` as them — the author check at
  `auth/writeAuth.ts:556-575` already admits the author — batched to the
  50-event ceiling (`handlers/space.roomy.space.sendEvents.ts:30`). Worth
  noting: a `deleteMessage` is a **hard** delete (`delete from entities where
  id = ?`, `packages/sdk/src/schema/events/message.ts:429`), with no soft-delete
  column anywhere, so it is irreversible — a stronger action than the retention
  position would suggest.
- Reactions the user left, their `user_thread_activity` rows, and their entries
  in `room_activity.recent_authors` unwind in the same pass. (The reactions
  already go in Phase 1, via the `comp_reaction.user` cascade.)
- This is a **bounded background job with a lease**, following the
  `voice_reconciler_lease` precedent (`schema-global.sql:282-292`), not a
  synchronous call: a user with thousands of messages in dozens of spaces
  cannot be made to wait on one HTTP request.
- The copy would change to "N messages deleted", with N computed before the
  user confirms.
- Guideline 5.1.1(v) permits this latency explicitly: *"If the deletion request
  will take additional time to complete, let them know."*

### 6.3 Phase 3 — deferral and the reaper

- An immediate-vs-scheduled choice, and a scheduled purge that the boot runner
  picks up (the resumable-task pattern already exists —
  `db/userSpaceMembershipMigration.ts:215-228` maps a version to a task and
  stamps completion only after full success).
- A reaper for DIDs whose PDS account is already gone, so a user who deletes
  at the PDS and never returns to Roomy is still purged. Nothing subscribes to
  identity events today (§2.5); the cheapest form is a periodic check that the
  DID still resolves to a live account, not a firehose subscription.

### 6.4 Phase 4 — the Roomy-hosted PDS (only if it ever matters)

Roomy operates `roomy.chat`, the PDS that serves `.roomy.chat` accounts
(§1.3). For those accounts Roomy *could* drive the whole flow — request the
deletion token by mail, then complete it with the user's password — because
the PDS is its own. That is a mail path, a token custody problem, and the
user's password, and it is a much larger commitment than this feature.
**Out of scope; recorded as the only design that would make "delete my
account" a single action.**

---

## 7. App Store acceptance mapping

### 7.1 The clause

> **5.1.1(v) Account Sign-In.** … If your app supports account creation, you
> must also offer account deletion within the app.

And its guideline reference page, *5.1.1(v) — Offering account deletion in your
app*, which is what actually governs the flow:

| Requirement | What answers it |
|---|---|
| "Make the account deletion option easy to find in your app. Typically, it's included in the app's account settings." | `/user/settings/account` + the sidebar entry (§5) |
| "Offer to delete the entire account record, along with associated personal data. You may include additional options, but only offering to temporarily deactivate or disable an account is insufficient." | The purge (§3.3, §4) removes the Roomy-side record; the link (§3.6) reaches the ATProto account record |
| "If people need to visit a website to finish deleting their account, include a link directly to the page on your website where they can complete the process." | The resolved-PDS `/account` link (§3.6) — for a `.roomy.chat` account that page is Roomy's own |
| "Keep people informed. … let them know what information will and won't be retained." | The disclosure copy (§3.8), including the retentions and the message outcome (§3.5) |
| "Apps that make it unnecessarily difficult for someone to delete their account will not pass review." | Two clicks from Settings, one confirmation — no email, no support flow (the FAQ forbids one for a non-regulated app) |
| "Does the content provided by a person need to be deleted…? Yes." | **Knowingly not fully answered — see below.** Authored messages are retained with their attribution stripped (§6.2). Phase 1's copy discloses this plainly rather than claiming the clause is met |
| Subscription disclosure | §3.8 and §5; only shown when the user actually has a subscription |

**The one clause Phase 1 does not fully meet, stated plainly.** The FAQ
question above covers user-generated content in shared apps, and Roomy keeps
the messages. The position taken is that space content is partly
community-owned (§6.2) — a defensible product stance, and the removal of the
author's name, avatar and profile is a real deletion of the account's presence
on that content. But it is a deviation, not a satisfaction, and the review
notes (§7.2) should say so rather than let a reviewer find it. If review
pushes back, the mitigation is Phase 2, which is designed (§6.2) but not
planned.

### 7.2 What "done" looks like for review

1. **The option is findable** without the reviewer reading the notes: Settings
   is one click from the sidebar user card and the option is on the Account
   page under it.
2. **It works end to end** on the build the reviewer has, with the flag on.
3. **The PDS link lands on a page that can complete the deletion** — for the
   app's own PDS, `https://roomy.chat/account`, which the reviewer will see
   branded "roomy.chat PDS".
4. **The note for App Review** (Guideline 2.1(a) requires notes for account
   features) states: which account types exist, that deletion is offered in
   Settings → Account, that the Roomy-side purge is immediate, that the ATProto
   account is destroyed at the user's PDS via the linked page, **and — in the
   same note — that messages the user posted in shared spaces remain as part of
   the space's history with the account's name and avatar removed.** §7.1 is
   why. Disclosing it in the notes is the difference between a considered
   product decision and something a reviewer discovers by testing.

### 7.3 Two review-time hazards, named

- **The reviewer will delete the demo account.** Guideline 2.1(a) requires a
  demo account for a login-gated app; Guideline 5.1.1(v) requires that account
  to be deletable. Those two pull against each other: after the first pass the
  demo account is gone and the next submission looks broken. **Decided: the
  review notes carry two demo accounts**, so a deletion during review cannot
  lock out the next pass (§8 decision 15; this was §9 Q4).
- **TestFlight is not exempt.** Guideline 2.2: apps distributed via TestFlight
  "should comply with the App Review Guidelines". The trigger condition is
  account creation, and the Register tab is unconditionally rendered
  (`LoginModal.svelte:267`), so the requirement binds **any build that can
  create an account**.
  **Settled: the shipping native build's PDS is `roomy.chat`** (§8 decision
  16; this was §9 Q5) — which means the build *can* create an account, so
  5.1.1(v) binds the TestFlight build and not only the web deployment. The
  caveat that cannot be closed from the repository, and should be checked
  once against the actual iOS build output: the iOS job builds with a bare
  `pnpm --filter app-lite build` and passes no `PUBLIC_*`
  (`release-tauri.yml:233-234`), and `.env` is gitignored (`.gitignore:41-44`).
  Public env for a static build is baked at build time into
  `_app/env.js` (`@sveltejs/kit` `generateEnvModule`), so the value comes from
  whatever environment that step ran in — and for the web deployment the
  Dockerfile supplies `PUBLIC_PDS` as a build arg (`Dockerfile.app-lite:13-14`).
  The build's startup log prints it (`+layout.svelte:71-73`,
  mirrored by `Dockerfile.app-lite:112`), so one run of the shipping build
  confirms the value in a single line rather than by inference.

---

## 8. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | "The reference `/account` page" is the PDS's own account page at `https://<pds>/account`, not a Roomy route | No `/account` route exists in the tree; the URL is live and is the only surface that can delete an ATProto account (§1) |
| 2 | Option B — Roomy-side purge + hand-off link | Option A is refused by the PDS's own auth (OAuth is rejected on `requestAccountDelete`); Option C leaves the appserver answering for a deleted user (§3.1, §3.2) |
| 3 | One new authenticated procedure, `space.roomy.user.deleteAccount`, no parameters, self-scoped | Nothing to parameterise; a body naming a DID is a body that can be aimed at someone else (§3.7) |
| 4 | The purge does not touch the user's repo, `did_owners`, or the `comp_page_edits` *rows* — it blanks their `user_id` only | The repo is the user's, on the user's PDS; `did_owners` is who may rotate a *space's* stream key, not the user's account; a page edit is a version of a collaborative document, so deleting it breaks the document and cascades its comments (§3.4, §8/11) |
| 5 | `bridge_token_grants` is retained; `pro_role_grants` is deleted, but only after its `removeMemberRole` is emitted | The bridge grant is load-bearing for a space still using the bridge; the role grant is the sweep's own bookkeeping and must go with its role (§3.5) |
| 6 | A `deleted_accounts` tombstone, written before anything is deleted, consulted by every user-keyed materialiser **and by `writeGlobalProfile`** | The global and per-space DBs are regenerable from `stream_events`, and the read path re-creates `profiles` rows; without the tombstone the next replay or the next read undoes the purge (§3.3, §4.4) |
| 7 | The hand-off is a plain `<a>` built from the resolved PDS endpoint; no per-callsite link handling | `routeLinkClick` already routes every off-origin https link to the OS (`link-routing.ts:129`); `AGENTS.md:306` forbids a second convention (§3.6) |
| 8 | The new scope goes into `base`, registered on the HappyView client *before* the code merges | A new `base` token that HappyView does not allow breaks sign-in for every user (§4.2) |
| 9 | Authored messages are **retained, with their author attribution removed**; Phase 1 does not delete them | Space content is partly community-owned; the `author`-edge cascade removes the account's presence on the message without a per-message delete (§3.3, §3.5) |
| 10 | The purge deletes the user's `admin` edges | They are the account's own membership rows, and a deleted account holding admin is the worse failure. A space left admin-less is recoverable by the remaining members; an admin-less state is a known follow-up, not a Phase 1 blocker (§9 Q1, now answered) |
| 11 | `comp_page_edits` rows are retained; only `user_id` is blanked (`set user_id = '' where user_id = <did>`) | A page edit is a version of a *collaborative document*; deleting the row rewrites the page's history and cascades the comments anchored to it (`comp_comment.version`, `schema-space.sql:191`) (§3.4) |
| 12 | The delete scope goes in `base`, registered on the HappyView client first | A user who is leaving should not have to pass a consent screen to do it (§4.2) |
| 13 | The iOS build does not advertise subscriptions; the account page still shows the billing notice to a user who has one | The `pro-subscription` flag hides the feature in the shipping build, but a subscription bought outside the app survives the deletion and keeps charging — the disclosure is per-user state, not per-build (§5) |
| 14 | **Phase 2 is not planned for the near term** | Phase 1 satisfies the review requirement, and Roomy treats space content as partly community-owned; §6.2 keeps the design of record without committing to it |
| 15 | The App Review notes carry two demo accounts | A deletion during review must not lock out the next submission (§7.3) |
| 16 | The shipping native build's PDS is `roomy.chat`, so 5.1.1(v) binds the TestFlight build | The build can create an account, which is the guideline's trigger condition; confirm the baked `PUBLIC_PDS` from one shipping build's startup log (§7.3) |

---

## 9. Questions, and how each was answered

All six are settled (§8 decisions 10–16); the reasoning is kept because each
answer was a choice, not a deduction, and the plan should not have to
re-derive it.

**Q1 — Does the purge delete the user's `admin` edges?** **Yes.** Deleting them
is the honest reading of "delete the account's data", and a deleted account
holding admin over a live space is the worse of the two failures. A space whose
only admin leaves is left admin-less and nobody can promote a replacement; that
is real but recoverable, and is tracked as a follow-up — an "this admin's
account is gone" state on `/[space]/settings/members` that lets the remaining
members act. Not a Phase 1 blocker. (§3.3, §8/10.)

**Q1b — Does the page-edit attribution survive?** **The rows survive; the
attribution does not.** `comp_page_edits.user_id` is blanked (`set user_id = ''
where user_id = <did>`), and the edit row, its document blob, and every comment
anchored to it are kept. The reasoning: a page edit is a version of a
*collaborative document*, so deleting the row would rewrite the page's history
and cascade the comments that reference it (`comp_comment.version` →
`comp_page_edits.edit_id`, `schema-space.sql:191`) — breaking a document other
people are still editing. Attribution removal satisfies the personal-data
interest without that. One implementation detail matters: `user_id` is
`not null` with no default (`:187`), so the scrub writes `''`, not `NULL`.
Verified against the real schema. (§3.4, §8/11.)

**Q2 — `base` scope or a deferred tier?** **`base`,** registered on the
HappyView client before the code merges. The alternative asks a user who is
*leaving* to pass a consent screen on the way out. (§4.2, §8/12.)

**Q3 — What does the flow say about a Roomy Pro subscription?** The iOS build
**does not advertise subscriptions** — the `pro-subscription` flag gates the
settings entry and the subscription page's content
(`routes/user/settings/subscription/+page.svelte:47-52`, `:170-176`), and it
ships off. But a subscription bought outside the app survives the deletion and
keeps charging, so the account page **still shows the billing notice to any
user who has one**, flag or no flag. This is possible because the notice reads
per-user state rather than the flag: `space.roomy.user.getMembershipStatus`
resolves live from Polar and is callable regardless of the feature flag — the
page's script already calls it unconditionally, and the flag only decides what
renders. (Do not link `https://apps.apple.com/account/subscriptions/`: that is
the FAQ's Apple-billing default, and Roomy Pro is billed through Polar,
`handlers/space.roomy.pro.createCheckout.ts:1-22`.) Whether a Pro grant should
also be *cancelled* server-side during the purge is deliberately left open —
it is a billing-policy call, and the disclosure is what the guideline requires.
(§5, §8/13.)

**Q4 — The demo account.** **Two demo accounts** in the review notes, so a
deletion during review cannot lock out the next submission. (§7.3, §8/15.)

**Q5 — Does the shipping native build set `PUBLIC_PDS`?** **It is
`roomy.chat`, so yes — the build can create an account, and 5.1.1(v) therefore
binds the TestFlight build.** Two caveats worth carrying rather than
rediscovering. First, this is *not* derivable from the repository: the iOS job
runs a bare `pnpm --filter app-lite build` with no `PUBLIC_*` in its env
(`release-tauri.yml:233-234`) and `.env` is gitignored (`.gitignore:41-44`).
Public env for a static build is baked at build time into `_app/env.js`
(`@sveltejs/kit`'s `generateEnvModule`), so the value comes from the
environment that step ran in; the web deployment's comes from Dockerfile
build args (`Dockerfile-app-lite:13-14`). Second, it is cheap to confirm
exactly rather than by inference: the app prints the whole public env block on
startup (`routes/+layout.svelte:71-73`), so one run of the shipping build
answers it in a line. (§7.3, §8/16.)

**Q6 — Does the disclosure need a data-export path alongside deletion?**
**No, and out of scope.** Guideline 5.1.1(v) does not require one, and Roomy
has neither an export flow nor a plan for one. Recorded so the omission is a
decision rather than an oversight.

---

## 10. References

**In-tree** (`origin/next` @ `508df18fd`)

- Entry and creation:
  `packages/app-lite/src/lib/components/auth/LoginModal.svelte:55-61,76-96,267,283-289`;
  `packages/app-lite/src/lib/auth.svelte.ts:375,658-715`;
  `packages/app-lite/.env.example:6-8`;
  `Dockerfile.app-lite:13-17,112`; `.github/workflows/release-tauri.yml:233-234`;
  `.gitignore:41-44`
- Settings surface:
  `packages/app-lite/src/routes/user/settings/+layout.svelte:30-44,105-140`;
  `packages/app-lite/src/routes/user/settings/+page.ts:1`;
  `packages/app-lite/src/routes/user/settings/subscription/+page.svelte:47-52,170-176`;
  `packages/app-lite/src/lib/queries/membership-status.ts`;
  `packages/app-lite/src/lib/components/sidebar/SidebarUserCard.svelte:163`
- Links:
  `packages/app-lite/src/lib/link-routing.ts:79-130`;
  `packages/app-lite/src/lib/external-link-handler.ts:60-100`;
  `packages/app-lite/src/routes/+layout.svelte:71-73,113`;
  `packages/app-lite/src-tauri/src/navigation.rs:27-37`;
  `packages/app-lite/src-tauri/tauri.conf.json:59-68`; `AGENTS.md:294-306`
- Scopes:
  `packages/app-lite/src/lib/scopes.ts:87-138,178-210,231-233,265-289`;
  `packages/app-lite/scripts/check-oauth-scopes.mjs:57-69`
- Appserver state:
  `packages/appserver/src/db/{paths.ts:9-14,db.ts:95-108,pool.ts:109-115}`;
  `packages/appserver/src/db/{eventsSchema.sql:2-6,58-61,readStateSchema.sql:3-5,31,47,57,84,114,129,136,146,159,185,205,221,237,254,287-305,schema-global.sql:14-15,35,51,70,124,185,214-230,282,schema-space.sql:31,47,83,144,147,163,179-196,248,293,312,322,408,434}`;
  `packages/appserver/src/db/readStateVersions.ts:156-159`;
  `packages/appserver/src/materialization/statementRouting.ts:11-31`
- Message and page materialisers (SDK):
  `packages/sdk/src/schema/events/message.ts:28,55-72,401-431`;
  `packages/sdk/src/schema/events/page.ts:32`;
  `packages/sdk/src/schema/events/space.ts:46-66,82-89`;
  `packages/sdk/src/schema/events/link.ts:49-58`
- Read path (the profile-row resurrection site):
  `packages/appserver/src/handlers/space.roomy.user.getProfile.ts:112,155,244`;
  `packages/appserver/src/queries/profileStore.ts:288,336,352-364`;
  `packages/appserver/src/materialization/profiles.ts:464-521,591-600`;
  `packages/appserver/src/queries/selectMessages.ts:221-260,634,638,712-733`;
  `packages/appserver/src/materialization/applyBatch.ts:379-386`;
  `packages/appserver/src/queries/userBlocks.ts:179,315-334`
- Auth and procedures:
  `packages/appserver/src/xrpc/authGuards.ts:30`;
  `packages/appserver/src/xrpc/auth.ts:13-60`;
  `packages/appserver/src/handlers/space.roomy.push.unregisterSubscription.ts:23-37`;
  `packages/appserver/src/handlers/space.roomy.space.leaveSpace.ts:118-140`;
  `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:30,78`;
  `packages/appserver/src/auth/writeAuth.ts:556-575`;
  `packages/appserver/src/handlers/space.roomy.user.getMembershipStatus.ts:41-60`;
  `packages/appserver/src/queries/{pushSubscriptions.ts:64,userSpaceMembership.ts:130-145,joinedSpaces.ts:168-194}`
- Registry and CI:
  `packages/appserver/src/featureFlags.ts:21-67`;
  `packages/docs/scripts/check-registry.ts:1-52`;
  `packages/docs/src/lib/endpoints/nsids.generated.json`;
  `packages/sdk/src/transport/registry.ts:166-243`

**Dependency** (installed, not vendored — `pds/node_modules` is gitignored;
`pds/package.json:8` declares `@atproto/pds: ^0.5.2`). Paths below are relative
to `pds/node_modules/@atproto/pds/`.

- `@atproto/pds@0.5.34`
  `dist/api/com/atproto/server/requestAccountDelete.js:19-25` (OAuth refused),
  `dist/api/com/atproto/server/deleteAccount.js:31-61` (password + emailed
  token),
  `dist/api/com/atproto/server/deactivateAccount.js:6-12` (OAuth refused)

**Network — measured 2026-10-13**

- `https://roomy.chat/account` → 200, `@atproto/oauth-provider` account page,
  `__customizationData.name = "roomy.chat PDS"`
- `https://bsky.social/account` → 200, same provider
- `https://roomy.chat/.well-known/change-password` → 302 to
  `https://roomy.chat/account/reset-password`
- `https://roomy.space/account` → 200, the Roomy SPA shell (not a page)

**External**

- App Review Guidelines 5.1.1(v):
  <https://developer.apple.com/app-store/review/guidelines/>
- Guideline reference, *5.1.1(v) — Offering account deletion in your app*:
  <https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion>
