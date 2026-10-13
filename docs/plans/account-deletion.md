# Account deletion — Implementation Plan

**Date:** 2026-10-13
**Status:** Planned. Not started. §1 is the research finding the rest of the
document rests on; §3 is the decision record and is the section to argue with
first. §9 Q1, Q1b, Q2 and Q5 are unanswered and gate Phase 1. §7 is what App
Review reads.
**Next:** Phase 1 (§6.1) — the deletion surface, the appserver purge, and the
hand-off link. It is the TestFlight-acceptable minimum and is independently
shippable. It is gated on one out-of-band step that must happen *before* the
code merges (§4.2): registering the new scope on the HappyView API client.
**Verified against:** `origin/next` @ `2e912191e22c1d5195125f74973cdce89b3cb27d`,
plus live network measurements taken 2026-10-13 (§1.3, §10).
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
  gitignored `.env` (`.gitignore:41-44`). The desktop/Android job in
  `release-tauri.yml` sets no `PUBLIC_*` at all, and the iOS job's frontend
  step is a bare `pnpm --filter app-lite build`
  (`release-tauri.yml:233-234`) — so whether a TestFlight build can create an
  account depends on a `.env` that is not in the repository, and therefore
  **cannot be established from the tree**. Determine it from the actual build
  environment before §7.2 is written; if the shipping native build has no
  `PUBLIC_PDS`, the Register tab throws `"No public PDS defined"`
  (`LoginModal.svelte:59`) and this plan's trigger condition applies to the web
  deployment first.

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
  is emitted as the author (`auth/writeAuth.ts:552-573` — author *or* space
  admin), one event per message, batched into a single `sendEvents` call up to
  50 events (`handlers/space.roomy.space.sendEvents.ts:30`,
  `mutations/message.ts:238-253`). Phase 2 builds on this.
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

1. **Read-state, one DID-scoped statement per table** — the 14 tables in
   §2.3, including all of the DID's `push_subscriptions` rows (every device,
   not just the current one) and `user_oauth_grants` / `user_scope_intents`.
2. **Global** — `edges` rows with `head = <did>` and
   `label in ('joinedSpace','leftSpace')`; the `profiles` row; `mentions` rows
   with `did = <did>`; `entity_space` rows for the DID as `entity_id`.
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
   - **Explicit, and one of them constrains the order.** `comp_user.did` is
     declared `references entities(id)` **without** `on delete cascade`
     (`:147`) — so the default `RESTRICT` applies, and the `comp_user` row must
     be deleted **before** the `entities` row or the whole per-space pass
     aborts on an FK violation. The rest have no FK at all and are simply
     missed by any entities-first cascade: `comp_page_edits.user_id` (`:186`),
     `member_roles.user_id` (`:294`), `comp_bans.user_did` (`:314`),
     `comp_invite.created_by_did` (`:325`), `call_participants.did` (`:436`),
     `room_activity.recent_authors` (`:414`).

   Two of those are named separately in §3.4 and §9 Q1 rather than folded in:
   `comp_bans.user_did` and `comp_page_edits.user_id`. Note the tension: §3.4
   says the page-edit row is retained, but its `entity` column still cascades
   when the user's entity goes. Phase 1 must therefore decide the ordering —
   copy the edit rows to a retained form first, or accept their loss — and that
   is §9 Q1b.

**Ordering within the per-space pass is load-bearing.** `comp_user` must go
first (§3.3 above). Everything else can follow in any order, because the rows
that have no FK are deleted explicitly and the ones that do are deleted by the
`entities` cascade at the end.
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
- **`comp_page_edits.user_id` — unresolved, see §9 Q1b.** The row is the author
  attribution on a page edit, and `comp_comment.version` references it
  (`schema-space.sql:186`, `:189-196`); pages are the *space's* artefacts, so
  the case for retaining it is that it is an attribution on shared content
  rather than the user's personal data. Against that: it is the user's authored
  content, and its `entity` column cascades when the user's entity row goes
  (`:183`), so retaining it is not the default — it takes deliberate work.
  **Phase 1 must pick one and the disclosure must match.** §9 Q1b is where that
  is decided.
- **`did_owners`.** It maps a space stream DID to the DID permitted to rotate
  that stream's key (`streams/keys.ts:14-34`, written from `streams/did.ts:45`
  with the creating admin). It is not user-account data, and a user who
  created a space leaving it un-rotatable would break the space.

### 3.5 The two rows that need an explicit answer

Both are read-state rows that look like the user's but are load-bearing for
somebody else. Neither is simply "retained": one is kept untouched and one is
deleted as part of a larger cleanup, and the disclosure must name both.
Guideline 5.1.1(v) asks for exactly this ("let people know what information
will and won't be retained"):

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
  registration, profile cache, mentions, and role grants.
- What Roomy does not delete: the ATProto account itself (with the link that
  does), any messages the user wrote in shared spaces (Phase 2 changes this —
  §6.2), the retained `bridge_token_grants` row, and — pending §9 Q1b — either
  the page-edit attribution or the page comments that depend on it. §3.5 says
  why for each.
- What happens to billing: Roomy Pro is billed through Polar, not Apple, so
  cancelling or refunding is a separate step. Guideline 5.1.1(v) asks the app
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

A second, narrower option exists and should be decided with Meri: put the
new token in a `DEFERRED_SCOPE_SETS` tier plus `UNREGISTERED_SCOPES` (the shape
`blocks` and `voice` already use, `scopes.ts:272-275`), and have the delete
flow request it on demand through the consent dialogue. That is more code and
one more consent screen for a user who is leaving. **Recommendation: the
`base` route, registered first.** See §9 Q2.

### 4.3 Handler behaviour

```
1. userDid = parseUserDid(auth);            // 401 when null
2. rows = selectUserSpaces(readStateDb, userDid, true)   // every space, incl. left
3. insert into deleted_accounts (did, deleted_at, reason)  // tombstone, first
4. for each space in rows: openSpaceDb(space).run(<per-space deletes, §3.3>)
5. openGlobalDb():    delete edges/profiles/mentions/entity_space for userDid
6. openReadStateDb(): delete the 14 tables of §2.3 for userDid
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

---

## 6. Phasing

Each phase is independently shippable. Phase 1 is the TestFlight-acceptable
minimum.

### 6.1 Phase 1 — the account page, the purge, and the hand-off

**Ships:** the settings route and nav entry; the `account-deletion` flag; the
`space.roomy.user.deleteAccount` procedure with its SDK schema, lexicon, route,
docs prose and regenerated registry; the `deleted_accounts` tombstone table
plus the materialiser guard that makes it authoritative; the disclosure copy;
the hand-off link.

**Blocked on, before the code merges:** the HappyView scope registration
(§4.2).

**Done means, observable:**

- On device: Settings → Account → Delete account → confirm → the app signs
  out, and the platform browser opens the PDS's account page for the correct
  PDS host.
- After the call, `space.roomy.space.getSpaces` returns no spaces for the DID,
  `space.roomy.user.getProfile` no longer answers from the materialised row,
  and no `push_subscriptions` row for the DID survives.
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

### 6.2 Phase 2 — the user's own content in shared spaces

Closes the gap Guideline 5.1.1(v)'s FAQ answers directly (§7.1: *"Does the
content provided by a person need to be deleted in apps that display and share
user-generated content? Yes."*).

- The author's own messages are deleted by emitting
  `space.roomy.message.deleteMessage.v0` as them — the author check at
  `auth/writeAuth.ts:552-573` already admits the author — batched to the
  50-event ceiling (`handlers/space.roomy.space.sendEvents.ts:30`).
- Reactions the user left, their `user_thread_activity` rows, and their entries
  in `room_activity.recent_authors` unwind in the same pass.
- This is a **bounded background job with a lease**, following the
  `voice_reconciler_lease` precedent (`schema-global.sql:282-292`), not a
  synchronous call: a user with thousands of messages in dozens of spaces
  cannot be made to wait on one HTTP request.
- Copy changes from "your messages remain in the spaces you were in" to "N
  messages deleted", with N computed before the user confirms.
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
| "Keep people informed. … let them know what information will and won't be retained." | The disclosure copy (§3.8), including the two retained rows (§3.5) |
| "Apps that make it unnecessarily difficult for someone to delete their account will not pass review." | Two clicks from Settings, one confirmation — no email, no support flow (the FAQ forbids one for a non-regulated app) |
| "Does the content provided by a person need to be deleted…? Yes." | **Phase 2** (§6.2). Phase 1's copy says plainly that authored messages remain |
| Subscription disclosure | §3.8; the exact copy is §9 Q3 |

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
   Settings → Account, that the Roomy-side purge is immediate, and that the
   ATProto account is destroyed at the user's PDS via the linked page.

### 7.3 Two review-time hazards, named

- **The reviewer will delete the demo account.** Guideline 2.1(a) requires a
  demo account for a login-gated app; Guideline 5.1.1(v) requires that account
  to be deletable. Those two pull against each other: after the first pass the
  demo account is gone and the next submission looks broken. The review notes
  must therefore carry either a second account or a stated way to recreate the
  first. This is an operational decision, not a code one — §9 Q4.
- **TestFlight is not exempt.** Guideline 2.2: apps distributed via TestFlight
  "should comply with the App Review Guidelines". The trigger condition is
  account creation, and the Register tab is unconditionally rendered
  (`LoginModal.svelte:267`) — but whether a given build can actually create an
  account depends on a `PUBLIC_PDS` that is not in the repository (§2.1). Settle
  that first (§9 Q5); if the shipping native build has no `PUBLIC_PDS`, the
  requirement binds the web deployment before it binds TestFlight.

---

## 8. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | "The reference `/account` page" is the PDS's own account page at `https://<pds>/account`, not a Roomy route | No `/account` route exists in the tree; the URL is live and is the only surface that can delete an ATProto account (§1) |
| 2 | Option B — Roomy-side purge + hand-off link | Option A is refused by the PDS's own auth (OAuth is rejected on `requestAccountDelete`); Option C leaves the appserver answering for a deleted user (§3.1, §3.2) |
| 3 | One new authenticated procedure, `space.roomy.user.deleteAccount`, no parameters, self-scoped | Nothing to parameterise; a body naming a DID is a body that can be aimed at someone else (§3.7) |
| 4 | The purge does not touch the user's repo, `did_owners`, or (pending §9 Q1b) `comp_page_edits` | The repo is the user's, on the user's PDS; `did_owners` is who may rotate a *space's* stream key, not the user's account (§3.4) |
| 5 | `bridge_token_grants` is retained; `pro_role_grants` is deleted, but only after its `removeMemberRole` is emitted | The bridge grant is load-bearing for a space still using the bridge; the role grant is the sweep's own bookkeeping and must go with its role (§3.5) |
| 6 | A `deleted_accounts` tombstone, written before anything is deleted, consulted by every user-keyed materialiser | The global and per-space DBs are regenerable from `stream_events`; without the tombstone the next replay undoes the purge (§3.3) |
| 7 | The hand-off is a plain `<a>` built from the resolved PDS endpoint; no per-callsite link handling | `routeLinkClick` already routes every off-origin https link to the OS (`link-routing.ts:129`); `AGENTS.md:306` forbids a second convention (§3.6) |
| 8 | The new scope goes into `base`, registered on the HappyView client *before* the code merges | A new `base` token that HappyView does not allow breaks sign-in for every user (§4.2) |
| 9 | Authored messages are Phase 2, not Phase 1 | It is a bounded background job with its own failure modes; Phase 1's copy states plainly what it does not delete (§6.2) |

---

## 9. Open questions

**Q1 — Does the purge delete the user's `admin` edges?** Deleting them is the
honest reading of "delete the account's data", but a space whose only admin
leaves becomes admin-less and nobody can promote a replacement. Keeping them
leaves a deleted account holding admin. *Recommendation: delete them, and
surface an "this admin's account is gone" state on
`/[space]/settings/members` that lets the remaining admins act — a follow-up,
not Phase 1.* This needs Meri's call before §4.3 is implemented.

**Q1b — Does the page-edit attribution survive?** §3.3. `comp_page_edits.user_id`
is the author of each page edit; `comp_comment.version` points at an edit row
and cascades from it. Retaining the edit row means keeping a deleted user's DID
on a page's history; deleting it means the page's comments go with it. The two
cannot both be had in the current schema. *Recommendation: delete both — the
edit is the user's authored content, and Phase 2 already deletes authored
content — and drop the retention claim in §3.4 for this column.* Needs a
decision before Phase 1, because it changes what the disclosure says.

**Q2 — `base` scope or a deferred tier?** §4.2. *Recommendation: `base`,
registered first — the alternative asks a departing user to pass a consent
screen to leave.*

**Q3 — What does the flow say about a Roomy Pro subscription?** Guideline
5.1.1(v)'s FAQ expects the app to tell the user that billing continues, and
points at `https://apps.apple.com/account/subscriptions/` — which is the wrong
link here, because Roomy Pro is billed through Polar
(`handlers/space.roomy.pro.createCheckout.ts:1-22`), not through Apple.
*Recommendation: state that Pro billing is separate and link to the
subscription settings page (`/user/settings/subscription`), and decide whether
a Pro grant should be cancelled server-side as part of the purge.*

**Q4 — The demo account.** §7.3. *Recommendation: two demo accounts in the
review notes, so a deletion during review cannot lock out the next pass.*

**Q5 — Does the shipping native build set `PUBLIC_PDS`?** §2.1, §7.3. Nothing
in the repository answers this: the iOS frontend step is a bare
`pnpm --filter app-lite build` (`release-tauri.yml:233-234`), no `PUBLIC_*`
appears anywhere in that workflow, and `.env` is gitignored
(`.gitignore:41-44`). *Recommendation: establish it from the actual build
environment before §7.2 is written — it decides whether the guideline binds
the TestFlight build, the web deployment, or both.*

**Q6 — Does the disclosure need a data-export path alongside deletion?**
Guideline 5.1.1(v) does not require one. Roomy has neither an export flow nor
a plan for one. *Recommendation: out of scope; note it here so the omission is
a decision rather than an oversight.*

---

## 10. References

**In-tree** (`origin/next` @ `2e912191e22c1d5195125f74973cdce89b3cb27d`)

- Entry and creation:
  `packages/app-lite/src/lib/components/auth/LoginModal.svelte:55-61,76-96,283-289`;
  `packages/app-lite/src/lib/auth.svelte.ts:375,658-715`;
  `packages/app-lite/.env.example:6-8`
- Settings surface:
  `packages/app-lite/src/routes/user/settings/+layout.svelte:30-44,105-140`;
  `packages/app-lite/src/routes/user/settings/+page.ts:1`;
  `packages/app-lite/src/lib/components/sidebar/SidebarUserCard.svelte:163`
- Links:
  `packages/app-lite/src/lib/link-routing.ts:79-130`;
  `packages/app-lite/src/lib/external-link-handler.ts:60-100`;
  `packages/app-lite/src/routes/+layout.svelte:113`;
  `packages/app-lite/src-tauri/src/navigation.rs:27-37`;
  `packages/app-lite/src-tauri/tauri.conf.json:59-68`; `AGENTS.md:294-306`
- Scopes:
  `packages/app-lite/src/lib/scopes.ts:87-138,178-210,231-233,265-289`;
  `packages/app-lite/scripts/check-oauth-scopes.mjs:57-69`
- Appserver state:
  `packages/appserver/src/db/{paths.ts:9-14,db.ts:95-108,pool.ts:109-115}`;
  `packages/appserver/src/db/{eventsSchema.sql:2-6,58-61,readStateSchema.sql:3-5,31,47,57,84,114,129,136,146,159,185,205,221,237,254,schema-global.sql:14-15,35,51,70,124,282,schema-space.sql:47,83,144,163,179,189,248,293,312,322,408,434}`;
  `packages/appserver/src/materialization/statementRouting.ts:24-37`
- Auth and procedures:
  `packages/appserver/src/xrpc/authGuards.ts:30`;
  `packages/appserver/src/xrpc/auth.ts:13-60`;
  `packages/appserver/src/handlers/space.roomy.push.unregisterSubscription.ts:23-37`;
  `packages/appserver/src/handlers/space.roomy.space.leaveSpace.ts:118-140`;
  `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts:30,78`;
  `packages/appserver/src/auth/writeAuth.ts:552-573`;
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
