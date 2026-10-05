# Space Requests — Plan

**Date:** 2026-10-05
**Commit (baseline):** `b9a83213` (`origin/next`)
**Status:** Plan — no code changes yet
**Owner:** appserver (surface), app-lite (prompt)
**Related:** `channel-federation.md` (the request flow being refactored onto this
abstraction), `denormalised-read-projections.md` (the read-cost model the
`getMetadata` decision is argued against)

## 0. Summary of decisions

| Question | Decision |
|---|---|
| What is a space request? | A fixed record: one *request kind* × one *space* × one *subject*, with a 4-state lifecycle. |
| Who consents? | The **space**, through a `SpaceGovernance` seam whose only implementation today is "caller holds the space's `admin` edge". |
| Where do requests live? | **Where the fact lives.** Federation keeps the global registry (cross-space fact). The discovery-consent request is a per-space setting (per-space fact). The *read surface* unions them. |
| New storage table? | **No.** A `space_requests` table would force the SDK materialisers to change table names — an on-protocol-visible break for every SDK consumer. See §4.5 and §9. |
| Unified read surface? | `space.roomy.space.getMetadata`, as an admin-only `requests[]` array. **No new NSID, no new OAuth scope, no new sync topic, no new route.** |
| Passive vs active? | A property of the request **kind**, not of the row. Passive never interrupts; active prompts on space open and is dismissible. |
| Dismissal? | Client-local, session-scoped. It hides the *prompt only*; the request stays in the inbox until answered. |
| First dispatchable phase | **Phase 1** (§7): the provider seam + federation read-side unification, no behaviour change. |

## 1. Problem

Two things today:

1. **Federation requests work, but they are one-off.** `space.roomy.federation.request.v0`
   is a request addressed to a space's admins, decided by a space's admins,
   surfaced through a dedicated query, a dedicated badge, a dedicated page
   (`channel-federation.md` §0). Nothing about that shape is reused, so the
   second request type pays for all of it again.
2. **A space's discovery consent has no asking mechanism.** A nullable
   `suggestToOthers`-style setting (TASK-283, in flight) is `null` until an
   admin answers. `null` must mean *unanswered*, and something must ask — once
   per such space, without nagging, and with a way to stop asking.

The plan is one abstraction that both use, with the federation flow refactored
onto it **without an on-protocol change**, and `null`-consent resolved by it.

Non-goals: individual **user**-scoped requests (explicitly a separate future
feature, closer to the push path — §6.5); transitive re-federation
(`channel-federation.md` §0); any change to the federation *grant* model
(origin/receiver grants, `auth/federation.ts`).

## 2. What exists today (grounded)

### 2.1 The federation request lifecycle

- **Events** (`packages/sdk/src/schema/events/federation.ts`):
  `request` (`:31-50`), `respond` (`:67-86`), `remove` (`:98-122`), plus the
  two grant events (`:143-163`, `:193-219`); the variant union is `:221-227`.
  The `request` materialiser writes `space_federations` and re-opens a
  `removed` row back to `pending` on re-request (`:40-44`).
- **Table** `space_federations` (`packages/appserver/src/db/schema-global.sql:134-145`),
  `status in ('pending','active','rejected','removed')`, `primary key
  (space_id, federating_space_did)`. It lives in the **global** DB because the
  relationship is cross-space by nature, and is routed there by statement text
  (`packages/appserver/src/materialization/statementRouting.ts:24-37`). Adding
  it needed no global version bump, because `initializeVersionedSchema`
  re-execs the schema file idempotently on a matching version
  (`packages/appserver/src/db/worker.ts:174-177`; `channel-federation.md:17`).
- **Reads** — four admin-gated queries sharing one gate
  (`packages/appserver/src/handlers/federationAdmin.ts:30-53`):
  `getRequests` (`.../space.roomy.federation.getRequests.ts:35-47`),
  `getIncoming`, `getOutgoing`, `getGrants`. Registered at
  `packages/appserver/src/appserver.ts:412-431`.
- **Writes** — `FEDERATION_TYPES` (`packages/appserver/src/auth/writeAuth.ts:215-221`)
  dispatched at `:956-972`; `request` requires *admin of B **and** member of A*
  (`:584-665`, with a 409 on an `active`/`rejected` pair), `respond` requires
  an admin of A against a `pending` row (`:706-758`), `remove` accepts an admin
  of either side (`:670-696`), `setReceiverPermission` requires an admin of B
  (`:767-783`).
- **Client** — queries `packages/app-lite/src/lib/queries/federation.ts`,
  mutations `.../mutations/federation.ts`, settings page
  `packages/app-lite/src/routes/[space]/settings/federations/+page.svelte`
  (admin-gated at `:35-38`, "Pending requests" section at `:300-345`), and a
  pending-count badge in `packages/app-lite/src/lib/components/sidebar/SpaceSidebarButtons.svelte:26-33`.

### 2.2 The two surfaces a new request type must join

- **`space.roomy.space.getMetadata`** (`packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:91-363`)
  returns space display fields, `isMember`, `isAdmin`, unread counts, and the
  sidebar tree. It is:
  - **cached** server-side (`CACHEABLE_NSIDS`, `packages/appserver/src/cache/index.ts:42-59`);
  - **invalidated** by every space-scoped change, including `updateSpaceInfo`
    (`packages/appserver/src/invalidation/inferSignals.ts:821-830`);
  - **already fetched on space entry and preloaded for every joined space at
    login** (`packages/app-lite/src/lib/preload.ts:98-114`), with
    `staleTime: Infinity` and the WS as sole freshness authority
    (`packages/app-lite/src/lib/client.ts:68,92`);
  - already carrying a caller-scoped field (`isAdmin`, `:355-356`) for which
    the cache has per-user eviction semantics
    (`packages/appserver/src/invalidation/types.ts:60-66`).
- **The invalidation namespace** — `QueryNsid` enumerates the four federation
  nsids (`packages/appserver/src/invalidation/types.ts:42-45`); sync topic
  routing maps them to the space topic (`packages/appserver/src/sync/handler.ts:68-74`).

### 2.3 The governance fact

"Admin of a space" is one query: an `edges` row with `label = 'admin'`
(`packages/appserver/src/auth/access.ts:185-189`), exposed via
`spaceAccess(...).isAdmin` (`:150-176`). It is already the sole consent gate for
federation responses. Adding an admin also inserts a `member` edge
(`packages/sdk/src/schema/events/space.ts:336-362`).

### 2.4 The nullable-setting precedent

`allow_public_join` is `null` = unset, defaulting to open:
schema `packages/appserver/src/db/schema-space.sql:96`, read as
`coalesce(allow_public_join, 1)` (`packages/appserver/src/auth/access.ts:201-215`),
projected as `allowPublicJoin: spaceRow.allow_public_join !== 0`
(`packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:352`),
written by `space.roomy.space.updateSpaceInfo.v0`
(`packages/sdk/src/schema/events/space.ts:137-210`, comp_space upsert at
`:194-207`), which is admin-gated (`writeAuth.ts:168-176`, dispatched `:937-939`).

**A nullable setting is therefore indistinguishable from this precedent, and
that is the point: `suggestToOthers` should behave exactly like
`allow_public_join`, with the one addition that the request system reads the
`null`.**

## 3. The abstraction

### 3.1 Identity

```
SpaceRequestKey = (kind, spaceId, subject)
```

- `kind` — the request type (`"federation"`, `"discoverability"`, …). A closed
  registry, not an open string: each kind has a provider (§3.5).
- `spaceId` — **the consenting space**. Always the space whose admins decide,
  and always the space whose `getMetadata` carries the request. For federation
  this is the origin/accepting space A, matching `space_federations.space_id`.
- `subject` — the counterparty. For a cross-space request it is the other
  space's DID (`federatingSpaceDid` for federation). For a request a space
  makes of itself it is the space's own DID. `subject` is what makes the key
  unique and what a "re-request after removal" compares against.

This deliberately reuses the federation registry's `(space_id,
federating_space_did)` precedent rather than inventing a new uniqueness rule
(§6.4).

### 3.2 The consenting actor: space + governance

The request's consenting actor is **the space**, never the individual admin who
happens to open the page. Today the space's will is exactly its admin list, so
the abstraction is one small module with one implementation:

```ts
// packages/appserver/src/auth/governance.ts
export interface SpaceGovernance {
  /** May `did` decide a request addressed to `spaceId`? */
  isAdmin(spaceId: string, did: string): Promise<boolean>;
  /** Who should be notified/prompted? */
  listAdmins(spaceId: string): Promise<string[]>;
}
```

`isAdmin` is `spaceAccess(openSpaceDb(spaceId), spaceId, did).isAdmin`
(`auth/access.ts:150-176`) with the same memoisation the federation handlers
already use; `listAdmins` is a single `edges` scan (`label = 'admin'`).

Why a seam and not just `access.isAdmin` inline: every rule the request system
needs from a space — "may this person decide", "who is prompted", later "is this
decided by a vote/role/arbiter" — flows through these two calls. Swapping the
implementation for a role-based or quorum-based one is a change to one file.
This is the whole of Meri's "abstracting over its governance implementation";
the flat admin list is implementation #1, not a special case.

### 3.3 State machine

Four states, mapping 1:1 onto `space_federations.status`
(`packages/appserver/src/db/schema-global.sql:137`):

| Unified state | Federation column | Meaning |
|---|---|---|
| `pending` | `pending` | Outstanding; awaiting the space's decision. |
| `active` | `active` | Consented; the request's effect is in force. |
| `rejected` | `rejected` | Declined. Terminal until re-requested. |
| `removed` | `removed` | Consent withdrawn after being `active`. |

Transitions, identical to the federation flow (`federation.ts:31-122`):

```
request          →  pending            (from nothing, or from `removed`)
respond(approve) →  active
respond(reject)  →  rejected
remove           →  removed            (from pending | active | rejected)
```

Two invariants, both already true for federation and both worth preserving:

- **Only `pending` is decidable.** `respond`'s materialiser guards on
  `status = 'pending'` (`federation.ts:75-84`) and `writeAuth` mirrors it
  (`writeAuth.ts:706-758`).
- **Re-request re-opens only from `removed`**; a `pending` re-request is an
  idempotent no-op and `active`/`rejected` is a 409 (`federation.ts:40-44`,
  `writeAuth.ts:626-658`).

### 3.4 Passive vs active

Character is a **static property of the kind**, declared once in the registry:

| | passive | active |
|---|---|---|
| Effect on the admin | none until they look | prompts on space open |
| Surfaces | inbox list + settings entry (+ optional badge) | inbox **and** a prompt |
| Dismissal | n/a (nothing to dismiss) | dismissible; dismissal hides the prompt only |
| Example | `federation` | `discoverability` |

Two design consequences, both deliberate:

1. **Passive does not mean invisible.** A pending federation request is already
   passive by this definition; it still gets the badge
   (`SpaceSidebarButtons.svelte:121-128`).
2. **Dismissing an active request does not resolve it.** Dismissal is
   session-scoped client state (§5.4); the request remains `pending` in the
   inbox until answered. An "active" request that could be dismissed away
   forever would defeat the purpose of asking at all (§5.5).

### 3.5 The provider seam

```ts
// packages/appserver/src/handlers/spaceRequests.ts
export type SpaceRequestKind = "federation" | "discoverability";
export type SpaceRequestStatus = "pending" | "active" | "rejected" | "removed";
export type SpaceRequestCharacter = "passive" | "active";

export interface SpaceRequest {
  kind: SpaceRequestKind;
  status: SpaceRequestStatus;
  subject: string;               // §3.1
  requestedByDid: string;
  requestedAt: number;
  message?: string;
  decidedByDid?: string;
  decidedAt?: number;
  decisionMessage?: string;
  /** Kind-specific view fields for that kind's dedicated surface. */
  detail?: Record<string, unknown>;
}

export interface SpaceRequestProvider {
  kind: SpaceRequestKind;
  character: SpaceRequestCharacter;
  /** Outstanding requests addressed to `spaceId`, for an admin caller. */
  list(ctx: { spaceId: string; spaceDb: DbLike; globalDb: DbLike }): Promise<SpaceRequest[]>;
}
```

Two implementations, and only two, because there are only two storage shapes:

- **`federationProvider`** — event-sourced. Reads `space_federations` from the
  global DB and maps rows to `SpaceRequest`. Its `detail` carries the fields the
  federation settings page renders today (peer space name, requester profile,
  message), reusing `resolveSpaceName` / `resolveProfiles`
  (`space.roomy.federation.getRequests.ts:49-68`).
- **`discoverabilityProvider`** — derived. Reads the space's nullable setting;
  when it is `null` the space has exactly one `pending` request whose `subject`
  is the space's own DID and whose `requestedByDid` is the space's DID. When the
  setting is set, it reports `active` (yes) or `rejected` (no) so the same
  provider can feed a "resolved" view without storing anything.

The aggregator is a loop, a concat, and a sort. Kind-specific behaviour accrues
*inside a provider*, which is exactly the "request types may accrue custom
behaviour as we come to them" Meri anticipated — added by writing one file, not
by widening the core.

## 4. Refactoring federation onto the abstraction

### 4.1 What does not change (the on-protocol surface)

Nothing. No lexicon changes for the federation path, no new event type, no new
NSID, no table rename, no migration:

- the five `space.roomy.federation.*` events and their materialisers stay
  byte-identical (`packages/sdk/src/schema/events/federation.ts`);
- `space_federations` and the two grant tables stay as-is
  (`schema-global.sql:134-178`), and stay routed globally
  (`statementRouting.ts:24-37`);
- `getIncoming` / `getOutgoing` / `getGrants` stay — they return *grants and
  history*, which are not requests, and the federation page needs them
  (`federations/+page.svelte:36-38,347-388`).

The SDK materialisers are the binding constraint here: they are shared by every
SDK consumer, and `statementRouting.ts` recognises the registry by **table
name** (`:26-28`). Renaming the table in the materialiser would change what
every consumer materialises and break that routing — an on-protocol-visible
break in all but name. §4.5 and §9 record the alternative and when it becomes
worth paying for.

### 4.2 What changes

**a. The read surface.** `getMetadata` gains an admin-only `requests` array:
`SpaceRequest[]`, assembled from the registered providers (default: pending
only). Non-admins get no key (or an empty array) — matching how `isAdmin`
already shapes that response (`getMetadata.ts:355-356`).

*Cost.* The federation provider adds one global-DB query to an admin's
`getMetadata` call — the same query `getRequests` runs today
(`space.roomy.federation.getRequests.ts:35-47`), now served from the cache the
sidebar already populates, instead of from a second per-space round trip made
by the badge (`SpaceSidebarButtons.svelte:27-30`) and a third by the settings
page (`federations/+page.svelte:35`). Net request count for an admin's space
entry goes **down**.

*Guard.* The provider list must stay bounded and must not fan out per row.
`federationProvider` does one query plus the per-row name/profile resolution the
existing handler already does; if that resolution becomes the dominant cost it
moves behind `detail` only (see §7 Phase 1 acceptance).

**b. Invalidation.** `federation.request.v0` currently invalidates
`getRequests` and `getOutgoing` only
(`packages/appserver/src/invalidation/inferSignals.ts:1048-1054`) — space A's
cached `getMetadata` is *not* evicted. Once the request lives there, it must be:

```ts
function handleFederationRequest(event) {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.federation.getRequests", { spaceId }), // kept while the NSID lives
    invalidate("space.roomy.federation.getOutgoing", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),      // NEW
  ];
}
```

`respond` and `remove` already invalidate `getMetadata` for the receiving
space B (`:1071`, `:1093`) but not for A; both gain A's `getMetadata` for the
same reason.

**c. The client's badge** stops calling `space.roomy.federation.getRequests` and
counts `metaQuery.data.requests` instead — one fewer query, and it now updates
on the same signal as everything else in the sidebar.

**d. The settings page's "Pending requests" section**
(`federations/+page.svelte:300-345`) reads the same array from the metadata
cache; its `refresh()` (`:70-80`) already invalidates `getMetadata`.

**e. `space.roomy.federation.getRequests`** stays registered and working, but is
no longer called by the client. Removing the NSID from the appserver and from
`APPSERVER_RPCS` (`packages/app-lite/src/lib/scopes.ts:84-135`, entry at `:122`)
is a separate, later, two-gate change: a token leaves the *requested* set but
stays in the metadata ceiling, and removing it from the ceiling is a deploy-time
edit (`AGENTS.md`, "Adding an OAuth scope"). Not worth it for one unused
endpoint; leave it.

### 4.3 Reuse vs change

| Component | Disposition |
|---|---|
| `space_federations`, grant tables, routing | **Reuse unchanged.** |
| `space.roomy.federation.*` events + materialisers | **Reuse unchanged.** |
| `checkFederation{Request,Respond,Remove}`, `checkSetReceiverPermission` | **Reuse unchanged** — they are the write side and stay the authority. |
| `requireFederationAdmin` (`handlers/federationAdmin.ts:30-53`) | **Generalise** to `requireSpaceAdminCtx` in `handlers/spaceRequests.ts`; the federation handlers import the generalised one. Same 401/403 behaviour. |
| `space.roomy.federation.getRequests` handler | **Superseded** by the provider; kept registered, uncalled. |
| `getIncoming` / `getOutgoing` / `getGrants` | **Reuse unchanged.** |
| `QueryNsid` union (`invalidation/types.ts:42-45`) | **Unchanged** for Phase 1 (federation nsids stay); nothing new is added, because the unified surface is `getMetadata`. |
| `topicsForSignal` (`sync/handler.ts:54-101`) | **Unchanged** — `getMetadata` already maps to the space topic (`:61-74`). |
| Client `createFederationRequestsQuery` | **Delete** (the badge and the page read metadata); the other three queries stay. |
| `SpaceSidebarButtons.svelte` badge | **Change** — count from metadata. |
| `federations/+page.svelte` "Pending requests" | **Change** — render from metadata. |

Nothing in the list requires a protocol version bump, a table migration, or a
downtime. Phase 1 is a pure read-path refactor with no behavioural delta — which
is what makes it the right first PR.

### 4.4 If a unified store is ever wanted

The design above is a **read-side** union, not a storage union. When a
unified store is justified (see §9 for the trigger), the migration is:

1. Add `space_requests` to `schema-global.sql` with
   `primary key (kind, space_id, subject)` and the §3.3 vocabulary. Additive DDL
   heals on a matching global version with no bump
   (`worker.ts:174-177`, `channel-federation.md:17`).
2. Add a `kind: "data"` entry to `GLOBAL_MIGRATIONS`
   (`packages/appserver/src/db/globalVersions.ts`) that backfills
   `space_requests` from `space_federations`. It runs once, at boot, and is
   idempotent — the same shape as the existing async-migration pattern.
3. **Only then** change the SDK materialisers, keeping `space_federations` as a
   compatibility view so any consumer on the old table still reads a correct
   answer.
4. Delete the shim in a later release.

Step 3 is the expensive one and is why this is *not* Phase 1.

### 4.5 Why not do it now

Because it converts a zero-risk refactor into an on-protocol change for a
benefit (one table instead of one table plus one column) that has no consumer
yet. The provider seam delivers the same single client-visible model in
Phase 1 at no protocol cost, and §9 names the trigger that flips the decision.

## 5. The discovery-consent request

### 5.1 The setting

TASK-283 adds a nullable per-space boolean, `null` meaning *unanswered* and
reading as "yes" — the exact shape of `allow_public_join`
(`schema-space.sql:96`, `auth/access.ts:201-215`, `getMetadata.ts:352`). The
request system does not care about the field's name; it cares that the state is
**three-valued on disk and two-valued on read**:

| stored | request | read |
|---|---|---|
| `null` | one `pending` `discoverability` request | yes |
| `1` | `active` | yes |
| `0` | `rejected` | no |

**Consequence for TASK-283, named here because it is a deployment cost:** a new
*column* on `comp_space` cannot be applied idempotently — a `create table if not
exists` does not alter an existing table, and the per-space DB has no migration
manifest (only global and read-state do, `globalVersions.ts` /
`readStateVersions.ts`). The column therefore requires a
`SPACE_SCHEMA_VERSION` bump, which **wipes and re-derives every per-space DB
from the event log** (`packages/appserver/src/db/db.ts:26-30`). Reads keep
serving the old DB throughout via the blue-green path
(`packages/appserver/src/db/worker.ts:352-374`), and the setting is re-derived
from its `updateSpaceInfo` event (`sdk/src/schema/events/space.ts:194-208`), so
this is a rebuild rather than data loss — but it is a real, fleet-wide operation
and should be sequenced deliberately. The cheaper alternative, a per-space
`space_settings(key, value)` table that heals without a bump, fragments the
space's settings and is not recommended for one column. *(TASK-283's actual
storage choice is not visible on `origin/next` — `[INFERENCE]`.)*

### 5.2 One request per unanswered space

For each space a caller can see, `discoverabilityProvider` emits **at most one**
request, and only when the setting is `null`. It is addressed to that space's
admins (§3.2), so:

- the request appears in `getMetadata` for admin callers only;
- the `subject` is the space's own DID (§3.1) — there is no counterparty, and
  writing the space's DID keeps the key shape uniform;
- uniqueness is a property of the column: a space cannot have two unanswered
  requests because its value is either `null` or not.

### 5.3 How the admin is prompted

The data is already there. At login, `preloadSpaceSidebars()`
(`packages/app-lite/src/lib/preload.ts:98-114`) fetches `getMetadata` for every
joined space; admins are always members
(`sdk/src/schema/events/space.ts:336-362`), so every space the caller can be
prompted about is in the cache. **No new endpoint, no new query, no server-side
fan-out** — the client derives the unanswered set from data it already holds.

Rendering, following the existing precedents:

- **Space-scoped prompt** — inside `packages/app-lite/src/routes/[space]/+layout.svelte`
  (which already reads `metaQuery`, `:19`), rendered only when
  `metaQuery.data.isAdmin === true` and `requests` contains a `pending`
  `discoverability` entry. This is Meri's "prompts the admin on opening the
  space".
- **App shell prompt** — when no space is open (the home route, `routes/+page.svelte`),
  a single prompt for the first unanswered space. The mount point and the
  dismissal model already exist: `EnableNotificationsBanner` is mounted once in
  `MainLayout.svelte:118` and gates itself on a local condition plus a
  `localStorage` dismissal key (`EnableNotificationsBanner.svelte:7,16,22-26`).
  The new prompt is the same component shape with a different condition.
- **Badge** — the per-space settings badge (`SpaceSidebarButtons.svelte:121-128`)
  counts *all* pending requests, passive and active alike (§3.4).

### 5.4 Answering

One action, the existing event, an additive field:

```
space.roomy.space.updateSpaceInfo.v0 { suggestToOthers?: boolean | null }
```

- Written via `sendEvents` on the space's stream, exactly like
  `updateSpaceInfo` today (`app-lite/src/lib/mutations/space.ts:57-82`).
- Admin-gated by `SPACE_MANAGE_TYPES` (`writeAuth.ts:168-176`, `:937-939`) —
  the governance seam and the write gate agree by construction.
- **Non-breaking.** An optional field on an existing event is compatible in both
  directions: arktype does not reject undeclared keys (verified against the
  pinned `arktype@^2.1.29`: a schema for `{a}` accepts `{a, b}`), the appserver
  is the only write path, and both ends ship together. No new event type, no new
  consent round-trip, no new OAuth scope.

Answering **resolves** the request, which is what clears it:

- `updateSpaceInfo` already invalidates `getMetadata` and `getSpaces`
  (`inferSignals.ts:821-830`), so the request disappears from every admin's
  inbox and every badge on the next signal, with no new invalidation plumbing.

### 5.5 Clearing, dismissing, and the difference

Three distinct outcomes, deliberately not collapsed:

| Action | Effect | Persistence |
|---|---|---|
| **Answer yes** | setting `1`; request → `active` | event-sourced, durable |
| **Answer no** | setting `0`; request → `rejected` | event-sourced, durable |
| **Dismiss / "not now"** | hides the *prompt*; request stays `pending` | client-local, per space + kind |

Dismissal is local because it is a UI preference, not consent: nothing else in
the system needs to agree on it, and the `EnableNotificationsBanner` precedent
(`:7`) is exactly this. It is scoped to the prompt so that an admin who dismisses
never silently loses the request — it remains in the inbox, on the badge, and in
the General settings row (§5.6) until answered. Meri's "clearable notices"
is satisfied without a dismissal record, and the unanswered state converges
rather than leaking.

### 5.6 Where it is surfaced in settings

Not a new route. The inbox is the `requests` array; the surfaces are thin
renders of it:

- **General settings** (`routes/[space]/settings/+page.svelte`) — the row where
  `allowPublicJoin` / `allowMemberInvites` already live. The unanswered state
  renders as a prompt with the two buttons; the answered state renders as the
  current value, changeable at any time.
- **Federation settings** — unchanged page; its "Pending requests" section reads
  the same array (§4.2d).

A dedicated `settings/requests` route is **not** built for two kinds (§6.1).

## 6. Meri's open questions, answered

### 6.1 Requests list in space metadata vs a dedicated surface

**Both, with metadata as the single source.** The abstraction is the array; the
surfaces are renders.

Evidence for metadata:

- it is already fetched on every space entry and preloaded for every joined
  space at login (`preload.ts:98-114`) — the active prompt's data arrives for
  free;
- it is already cached and invalidated by every space-scoped signal
  (`cache/index.ts:42-59`, `inferSignals.ts:821-830`);
- it already carries the caller-scoped `isAdmin` flag the request list is gated
  on, with per-user cache eviction semantics
  (`types.ts:60-66`, `getMetadata.ts:355-356`);
- **it costs no new NSID.** A dedicated `space.roomy.space.getRequests` would
  need a new lexicon, a new handler, a new `QueryNsid` member, a new
  `topicsForSignal` case, and — the expensive part — **an OAuth scope added to
  the metadata ceiling *and* registered on the HappyView API client** before any
  client could call it (`packages/app-lite/src/lib/scopes.ts:175-178,262-266`,
  `AGENTS.md` "Adding an OAuth scope"). Folding into `getMetadata` is already
  inside `APPSERVER_RPCS` (`scopes.ts:86`).

Against metadata: it is the hot sidebar read (p95 279 ms/7 d,
`denormalised-read-projections.md` "what is actually slow"). The mitigation is
that the provider list is bounded, admin-only, and served from the response
cache that the sidebar already populates — and it *replaces* two existing
per-admins round trips (§4.2a).

### 6.2 Active-request interruption mechanics

Prompt on space open, data from cache, dismissal client-local:

1. `getMetadata` for the open space is already resident (space-entry query,
   `routes/[space]/+layout.svelte:19`; preloaded at login).
2. The space layout renders the prompt iff `isAdmin` **and** a `pending` request
   of an `active` kind is present.
3. Dismiss hides it for the session and is remembered per `(spaceId, kind)`;
   the badge and inbox entry remain.
4. The home route renders one prompt from the preloaded metadata when no space
   is open, mounted like `EnableNotificationsBanner` (`MainLayout.svelte:118`).

It never blocks navigation and never modal-locks; the prompt is an inline
banner, not an interstitial.

### 6.3 Per-space or global state

**Where the fact lives**, argued from the two precedents:

- The federation *relationship* is a cross-space fact — it is consulted while
  serving a space the caller is not a member of, it is read by two spaces, and
  it is stored in the global DB for exactly that reason
  (`statementRouting.ts:24-37`, `channel-federation.md` §4.1). Its grant tables
  are keyed on the origin and read by the receiver.
- Discovery consent is a fact **about one space**, read only while serving that
  space, consumed by that space's admins, and set by that space's admins. It is
  the same shape as `allow_public_join`, which lives in the per-space
  `comp_space` (`schema-space.sql:96`). Storing it globally would create a
  second source of truth for a per-space fact and require cross-DB reconciliation
  on every space update.
- The one thing a global store would buy — "enumerate every space whose consent
  is unanswered" — is already answered on the client by the login preload
  (§5.3), with no server-side cross-space index. `space_stats`
  (`schema-global.sql:202-207`) exists because the admin dashboard needed
  cross-space *ordering*; nothing here does.

So: **per-space storage, unified read surface.** The `SpaceRequest` record's
`spaceId` is what lets the surface be space-scoped in both cases.

### 6.4 Uniqueness and scoping

The federation precedent is `primary key (space_id, federating_space_did)`
(`schema-global.sql:144`) — one relationship per (consenting space, counterpart),
with history carried in `status` rather than in extra rows, and re-opening only
from `removed` (`federation.ts:40-44`).

**Reuse it; do not extend the table.** `SpaceRequestKey = (kind, spaceId,
subject)` generalises it: `kind` disambiguates request types against the same
space, `spaceId` is the consenting space, `subject` is the counterpart (or the
space itself, for self-addressed requests). Federation's `kind` is the constant
`"federation"` and its `subject` is literally `federating_space_did`, so no
federation key changes meaning and no federation row is re-keyed.

History handling follows the precedent exactly: one row per key; `removed`
re-opens to `pending`; `pending` re-request is idempotent; `active`/`rejected`
is a 409 (`writeAuth.ts:626-658`). The same rules apply to any future kind
unless its provider overrides them in its own write path — which is the point of
the seam.

### 6.5 User-scoped requests stay out

Meri's framing is right: an individual user's "request" is *not* this. It has no
space governance, no space-scoped consent gate, and its delivery wants the push
pipeline (`notification_state`, `readStateSchema.sql:154-163`; the dispatcher in
`src/push/`). Forcing it into this model would put per-user state into a
space-governed table and give the request list a second consenting actor. Keep
it separate; the `SpaceRequest` record is deliberately space-shaped.

## 7. Phasing

Each phase is one reviewable PR.

### Phase 1 — The seam + federation read unification (backend, no behaviour change) ← **FIRST DISPATCHABLE**

*Deliverable.*
- `src/auth/governance.ts` — `SpaceGovernance` with the existing admin-edge
  implementation, memo-compatible.
- `src/handlers/spaceRequests.ts` — the `SpaceRequest` record, the
  `SpaceRequestProvider` interface, the kind registry, the aggregator, and
  `requireSpaceAdminCtx` (generalised from `requireFederationAdmin`,
  `handlers/federationAdmin.ts:30-53`).
- `federationProvider` mapping `space_federations` rows → `SpaceRequest`.
- `getMetadata` returns `requests: SpaceRequest[]` for admins (pending only).
- `inferSignals`: `federation.request.v0` (and `respond`/`remove`) invalidate
  space A's `getMetadata` in addition to what they emit today
  (`inferSignals.ts:1048-1099`).
- SDK `getSpaceMetadata.Response` gains the optional `requests` array
  (`packages/sdk/src/schemas/queries/getSpaceMetadata.ts:68-87`).

*Acceptance.* For any space with a pending federation request, an admin's
`getMetadata.requests` contains an entry with `kind: "federation"`, the same
`subject`/`requestedByDid`/`requestedAt`/`message` as
`space.roomy.federation.getRequests` returns, and the federation settings page
plus the badge are unchanged apart from reading it from the new array. Non-admin
callers get no requests. Existing federation unit and E2E tests
(`src/auth/writeAuth.federation.test.ts`, `src/materialization/federation.test.ts`,
`src/e2e/federation.test.ts`) pass untouched.

*Not in this phase:* any change to events, tables, materialisers, lexicons,
scopes, or the discovery setting.

### Phase 2 — Discovery-consent request (backend + prompt)

*Deliverable.* The nullable per-space setting and its `updateSpaceInfo`
materialiser field; `discoverabilityProvider`; the space-layout prompt and the
app-shell prompt; the General settings row.

*Depends on:* TASK-283's storage decision and its schema-version sequencing
(§5.1). If TASK-283 ships the setting first, this phase is purely the provider
and the UI.

*Acceptance.* A space whose setting is `null` yields exactly one `pending`
`discoverability` request to each of its admins; answering from the prompt sets
the value, the request disappears from the inbox and the badge on the next
signal, and the value persists across a space-DB rebuild.

### Phase 3 — Retire the federation-specific read path (client)

*Deliverable.* Delete `createFederationRequestsQuery`
(`app-lite/src/lib/queries/federation.ts:11-19`), switch the badge and the
settings page to the metadata array.

*Acceptance.* No client call to `space.roomy.federation.getRequests`; the badge
count matches `requests.length`; the page's pending section is unchanged in
behaviour.

### Phase 4 — Consolidation (only when a third kind exists)

A `settings/requests` route, and — if the code branching in the aggregator has
actually become a cost — the unified `space_requests` store of §4.4. Neither is
warranted for two kinds.

## 8. Risks

1. **`getMetadata` cost.** It is a hot, cached read; the provider list runs on
   the admin path only. Bound it by keeping each provider to a small, fixed
   number of queries and no per-row DB fan-out outside `detail`; measure before
   and after (the perf harness auto-discovers endpoints,
   `packages/appserver/src/appserver.ts:551-558`).
2. **Cache correctness.** The requests array is caller-scoped (`isAdmin`), so
   its invalidation must carry the right scope; the existing signal for
   `updateSpaceInfo` is already caller-scoped in effect
   (`inferSignals.ts:821-830`). The **new** risk is `federation.request.v0`
   being currently under-invalidating for A (`:1048-1054`) — Phase 1 fixes it,
   and without that fix the feature is visibly wrong under the response cache.
3. **The per-space schema bump** (§5.1). A new `comp_space` column forces a
   fleet-wide re-materialisation. Sequence it, don't discover it in review.
4. **Governance seam over-abstraction.** Two methods, one implementation. If a
   second implementation does not appear, resist adding a third method.
5. **Dismissal semantics.** If dismissals were persisted server-side they would
   need per-user durable state (`readStateSchema.sql` is the home for that) and
   would have to be reconciled against the setting. Session-local dismissal
   (§5.5) avoids both; keep it that way until an admin complains.

## 9. Considered and rejected

- **A unified `space_requests` table, now.** Rejected for Phase 1: it forces the
  SDK materialisers to change table names, which every SDK consumer materialises
  and which `statementRouting.ts:26-28` matches by text — an on-protocol change
  hidden inside a "refactor". §4.4 gives the migration; the trigger to pay for
  it is **a third request kind with a non-federation storage provider**, at
  which point three providers over one table beats three providers over three
  stores.
- **A dedicated `space.roomy.space.getRequests` NSID.** Rejected: it buys a
  cleaner separation at the cost of a new lexicon, handler, invalidation
  namespace entry, sync topic case, and — decisively — a new OAuth scope that
  must be registered on the HappyView client before anyone can call it
  (`scopes.ts:175-178`; `AGENTS.md`). `getMetadata` already ships with all of
  that infrastructure and is already loaded when the prompt must fire (§6.1).
- **Server-side dismissal records.** Rejected: durable per-user state for a UI
  preference, with no consumer that needs agreement on it. §5.5.
- **Modelling user-scoped requests here.** Rejected: no space governance, and
  the delivery channel is push (§6.5).
- **Storing discovery consent in the global DB.** Rejected: a per-space fact
  belongs with the space (§6.3); the one enumeration it would enable is already
  answered client-side by the login preload.
- **Extending `space_federations` to carry `kind`.** Rejected: it would give
  every federation row a discriminator it does not use, and would put a
  non-federation request into a table named for federations. The provider seam
  keeps the read model unified without pretending the storage is.

## Appendix — state mapping

| | `pending` | `active` | `rejected` | `removed` |
|---|---|---|---|---|
| `space_federations.status` | `pending` | `active` | `rejected` | `removed` |
| Discovery setting | `null` | `1` | `0` | n/a |
| Federated access in force | no | yes | no | no |
| Decidable | yes | no | no | no |
| Re-request allowed | idempotent no-op | 409 | 409 | yes → `pending` |
