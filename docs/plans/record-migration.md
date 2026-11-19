# Record-shaped output and the space record browser

Status: in progress — 2026-11-19. P1 merged (#614, `473f2044`). P2 in review
(#615) and **blocked on D7's grant split**. P3 in review (#616), stacked on P2.
P0's production backfill has not been run: the counts below come from a dev-VM
copy of the log, so confirm the shape on production before sizing P4.
**Next: P4, the browser** — dispatchable once P3's endpoints merge; P5 waits on
permissioned spaces (Dec 2026). Companion:
`packages/appserver/docs/plans/replicable-space-workers.md` §5 WS3 (the
change-record interface this builds on).

## 1. What already exists

| Piece | Where | State |
|---|---|---|
| Event → record-change adapter | `packages/appserver/src/materialization/records/toRecordChanges.ts:333` | complete: 47 event types map onto 16 record kinds; 6 produce no record (4 deliberate omissions + 2 synthetic types) |
| Kind table | `records/recordKinds.ts:434` | collection NSID, rkey parts, body and patch types per kind |
| Persisted feed | `src/db/eventsSchema.sql:56` (`record_changes`) | one row per change, `(stream_id, idx, ord)` primary key, `body` JSON with `{"$bytes": "<base64>"}` |
| Live writer | `src/streams/StreamManager.ts:245` | every accepted batch writes the feed in the same call as the log append (since `75f95f72`, 2026-10-24) |
| Backfill | `packages/appserver/scripts/backfill-record-changes.ts` | walks `stream_events`, idempotent (`insert or replace`), `--dry-run` and `--stream` |
| Readers | `src/streams/recordChanges.ts:221`, `crates/space-*` | the change feed is already the materialiser's input and the Rust worker's parity fixture |
| Space repos | `packages/appserver/scripts/migrate-spaces-to-pds.ts` | the one-time script provisions one: PDS account, PLC `#atproto_pds` repointed, `space.roomy.service/self` written, password recorded to CSV. Confirm against production that it ran for every live space. |

So the transform is done, the feed is live, and the space half of the repo
mapping is already provisioned. What does not exist is a **view of the feed as
current records**, and any way to look at one.

### Measured on a real log

A 14-space snapshot of the log found on the dev VM (`roomy-events.sqlite`,
14,917 events, last write 2026-10-28 — **not** production) run through the
backfill takes 0.5 s and produces 15,465 changes. Folding those (a throwaway
probe, not committed):

- **13,386 current records**: 12,213 in user repos, 1,173 in space repos.
- By kind: message 12,757 · room 609 · membership 8 · reaction 3 ·
  federationRequest 2 · federationGrant 2 · roleGrant 2 · spaceInfo 1 ·
  spaceSidebar 1 · profile 1.
- Of the message rewrites, 7 are the author editing their own record and 5 rows
  (3 records) are an admin writing over someone else's — the whole D5 "curator
  write" population on this log. The problem is real but rare, which supports
  deferring it.
- The folded message bodies already carry `author`, so ownership for D1 is
  recoverable from the record itself, not only from the row's `actor`.
  System messages carry the space as `author` and the acting DID in `actor`,
  matching the WS3 note.

Confirm the same shape on production before sizing P3/P4; the ratio of
user-repo to space-repo records is the number that decides whether the browser
is a small admin tool or a per-user surface.

## 2. The gap, precisely

1. **No fold.** `record_changes` is a log of ops; nothing turns it into the
   current set of records. Six kinds never emit `create` (`spaceInfo`,
   `spaceSidebar`, `roomPermission`, `federationGrant`, `profile`,
   `calendarLink` — the adapter is stateless, so it emits `update`), and
   `membership` can update without a prior create. A fold must therefore treat
   `update` on an absent key as create, merge patches shallowly, and drop on
   `delete`.
2. **Bodies are internal shapes, not records.** `MessageRecord.content` is
   `{mime, bytes}`; a lexicon record needs `$type`, `createdAt`, and blob refs.
   The NSIDs in `RECORD_KINDS` are explicitly provisional (`recordKinds.ts:425`)
   and only `space.roomy.user.profile` exists under `lexicons/`.
3. **Repo policy is implicit.** `toRecordChanges` derives the repo per event
   and documents the two exceptions in its header; there is no table, no test
   asserting the whole policy, and one class of case is deliberately unresolved
   (§3 D5).
4. **No read surface.** No XRPC query returns records, and no UI shows them.

What closes what, as of 2026-11-19: **1 by P1** (`records/foldChanges.ts`), **2
by P2** (`records/toRecordJson.ts` and the lexicons — 16 after D7's split),
**4 by P3** (the `space.roomy.admin.getSpaceRecords` family). **3 is open**: the
policy is still implicit in the adapter, and D1's fold-time resolution is the
answer in use rather than a table anyone asserts against. D5's "cannot be
expressed" list is counted by P2's serialiser and reported by P3/P4, not
resolved.

## 3. Decisions to make

**D1 — Is the record set "what the log says" or "what migration wants"?**
The adapter's repo derivation matches the intended policy for creates: message
creates and reactions go to the author (`messageAuthor`, including the bridge
author override), profiles to the subject, everything else to the space DID.
Edits, deletes and moves go to the space DID unconditionally, including when the
author is the actor. That is defensible today and wrong as a statement of intent,
because it puts a user's own edit of their own message in the space repo while
the create is in theirs.

Recommended: keep the stored feed as-is (it is the worker's input, and changing
it is a separate decision), and make the **fold** resolve the repo of an
`update`/`delete` to the repo that holds the record — the row carries `actor`,
so "actor owns the existing record → apply there, else the space repo" is
derivable without touching the adapter. Expose both in the browser: the stored
repo and the folded one, with a diff badge.

**D2 — Which records are "the space"?** The browser needs a definition to page
over. Recommended: every record whose repo is the space DID, plus the records
whose repo is a member DID but which were produced by an event on this space's
stream (i.e. everything in `record_changes where stream_id = <space>`, grouped
by repo). That is exactly the feed's scope and needs no new bookkeeping.

**D3 — Blob representation in the JSON view.** The feed already carries
`{"$bytes": "<base64>", "mime": …}`. Recommended: show that verbatim with a
mime and byte-length badge, and mark the field `blob (upload on publish)`. Do
not base64-inflate images in the record view.

**D4 — `createdAt`.** Use the order stamp's time (`decidedAtFor`, i.e. the log's
`received_at`), not a wall clock at render time, so two renders of the same
record agree. The protocol would take a client-minted time; the difference is
one field and is not worth resolving before records are actually published.

**D5 — Writes over another author's record.** Edits/deletes by an admin, moves,
third-party profile writes, and the `createRoomLink` system message (authored
by the space, acting DID only in the body) have no honest home in a per-repo
model. Recommended: do **not** solve this now. Emit them as the space repo (as
today), list them explicitly in the browser under "records that cannot be
expressed in the author's repo", and count them — the count is the question the
community needs answered before a migration format is agreed.

**D6 — Who can look.** Recommended: the endpoint requires the appserver admin
allowlist (`requireAdmin`) in this phase, matching `space.roomy.admin.*`; a
space-admin variant can follow once the shape is settled, and needs
`requireSpaceAdminCheck` (currently module-private in `auth/writeAuth.ts:389`)
exported. The docs site already authenticates as the user with service auth
(`packages/docs/src/lib/xrpc.ts`), so the browser needs no new auth path.

**D7 — Federation grants are two records, split by who decided. Decided
2026-11-19.** The draft modelled one record per receiving space B, living in
A's repo, holding both what A granted (`origin`) and what B granted
(`receiver`). That record is rejected: its two halves are decided by two
different admins in two different logs (`setRoomPermission` is sent on A's
stream, `setReceiverPermission` on B's), the fold's input is one stream's rows,
and no order relates the two logs. A is also not the author of B's decisions,
and under permissioned spaces A cannot write B's repo at all. The split:
`space.roomy.federation.grant` stays in A's repo, keyed by B, holding `origin`;
`space.roomy.federation.receiverGrant` lives in B's repo, keyed by A, holding
`receiver`. One event is one **entry** change, not one record: the fold upserts
or removes an entry keyed by `room` (origin) or `room`+`grantee`+`granteeKind`
(receiver), and `permission: null` removes it — the rule the global projection
already encodes in `federation_room_permissions` and
`federation_receiver_permissions`. `federation.remove` deletes A's record;
B's receiver record is left with no ceiling, so it grants nothing, and is
cleaned on B's next write.

**D8 — Bridged profiles are out of scope. Decided 2026-11-19.** The only writer
of `space.roomy.user.updateProfile.v0` is the Discord bridge; an ordinary user's
profile is a `space.roomy.user.profile/self` record their own client writes to
their own PDS, so it needs no fold entry and no migration. A bridged profile is
a Discord mirror carrying a `handle` and an `atblob://` avatar, neither of which
the deployed record has a field for, and its key is the literal `self`, so one
bridge account cannot hold one per bridged user. The way back: define a
`space.roomy.user.bridgedProfile` record (subject-keyed, carrying `handle` and a
blob avatar), have the bridge write those instead of `updateProfile` events, and
let the profile read path fall back to it. **Until that exists a bridged user's
profile does not survive a cutover** — a known gap, carried in §6, not a silent
loss. The `profile` kind stays in the fold as a view of the projection only; it
is not a publish target.

## 4. Phases

### P0 — Backfill and count (hours)

Run `backfill-record-changes.ts` against production with `--dry-run` first, then
for real. This is a Railway one-off against `/data/roomy-events.sqlite`; it
writes only `record_changes`, is idempotent, and does not touch `stream_events`.

Acceptance:
- `select kind, count(*) from record_changes group by kind` — every kind
  present that the event inventory predicts; `message` dominates.
- `select count(distinct stream_id) from record_changes` equals the number of
  streams in `stream_events` that hold at least one event emitting a record.
- Spot check: for three spaces, the folded message count equals
  `count(createMessage) + count(forwardMessages) + count(createRoomLink) -
  count(deleteMessage)` over that stream's events. `comp_content` is not the
  oracle: a forwarded message has no content row.
- For the three spaces above, `bun run scripts/dump-space-records.ts --space
  <did>` and a hand read of one room.

### P1 — Fold and dump (1–2 days)

New `src/materialization/records/foldChanges.ts`: pure
`RecordChangeRow[] → FoldedRecord[]`, with the D1 repo resolution and D2 scope.
Keep it pure and dependency-free so the Rust worker and the endpoint share the
same semantics. New `scripts/dump-space-records.ts` printing JSONL
(`{repo, collection, rkey, op, record}`), `--space`, `--repo`, `--collection`.

Acceptance: corpus test (the existing `records/corpus.ts` fixture) folded and
compared against the materialiser's rows for messages, rooms and memberships;
dump on a production copy reviewed by hand for one space.

**This is the milestone that answers "what would this space look like as
records", with no lexicons and no UI.**

### P2 — Lexicon-shaped serialisation (2–3 days)

`records/toRecordJson.ts`: per-kind fold output → a lexicon-valid record —
`$type` from the collection, `createdAt` from the stamp (D4), blob fields
marked (D3), internal-only fields dropped. Write the 15 lexicons under
`packages/appserver/lexicons/space/roomy/`, using `user/profile.json` as the
template (it already has `key`, blob `accept`/`maxSize`, `createdAt`). Publish
them with `scripts/publish-lexicons.ts` so the NSIDs resolve for anyone reading
the records later.

Acceptance: every folded record validates against its lexicon (add
`@atproto/lexicon`, already a `@roomy-space/sdk` dependency, to the appserver;
or expose the SDK's validator), corpus-wide; no record carries a field its
lexicon does not declare. The two grant kinds' lexicons are D7's two records,
not one record with both arrays.

### P3 — Endpoints (1–2 days)

- `space.roomy.admin.getSpaceRecords` — `{space, repo?, collection?, cursor, limit}`
  → `{records: [{repo, collection, rkey, record, op}], cursor}`. Reads the events
  DB only (the feed is partitioned by `stream_id`, so no per-space DB is opened).
- `space.roomy.admin.getSpaceRecordCounts` — per-kind and per-repo counts, for
  the browser's tree and for the "cannot be expressed" tally.

Fold on read with an in-process LRU keyed by `(space, stream_state.latest_event)`;
a fold of a mid-size space is a single ordered scan of its partition. No new
table unless measurements say otherwise.

Acceptance: E2E test booting `createAppserver` with `:memory:` DBs, a corpus
written through `sendEvents`, then the query returning the folded set; pagination
is stable across a concurrent append.

### P4 — Browser (2–3 days)

New route in `packages/docs` (`src/routes/records`), reusing the dashboard's
auth and XRPC client: space picker → repo list with counts → collection list →
record JSON pane, pdsls-style, plus a "flags" panel fed by D5's tally. Read-only;
no write paths.

Acceptance: drive it in a browser against a local appserver seeded with the
corpus fixture; a space's records are navigable end to end and the JSON matches
`dump-space-records.ts` for the same space.

### P5 — Publish into permissioned spaces (blocked until Dec 2026)

The target is **permissioned spaces**, not public repos: a space is
`at://{authority}/space/{type}/{skey}`, the authority's PDS hosts it and decides
who may read it, and **every writing account holds its own repo in it, on its
own PDS**. Publication therefore means writing a record into the writer's own
repo within a space. It needs three things this document does not have yet:

- **a space-capable PDS and a space credential** — the host issues one in
  exchange for a delegation token the user's PDS mints. The beta is expected to
  open this to all Bluesky users in December 2026.
- **a space dimension in the record model.** A record's address there is
  `(space, repo DID, collection, rkey)`, and `RecordChange` carries only the
  repo DID today (§6 Q2).
- **a blob step** for `$bytes` message attachments and `atblob://` avatars.

Nothing in P0–P4 writes to a PDS: the pipeline is pure and stops at in-memory
records (`foldChanges`, `dump-space-records`, `toRecordJson`). The space repos
provisioned by `migrate-spaces-to-pds.ts` — a PDS account per space DID — are a
transitional shape, not the target. What P5 unblocks is credible exit: a space
admin moving their space with all its data, then each user's data to their own
account.

## 5. Verification

- P1's corpus fold is the correctness oracle; it runs in `bun test` like the
  existing record tests.
- P3's endpoints are covered by an E2E test under `src/e2e/`.
- P4 is verified by driving the page, not by a unit test.
- Throughout, `stream_events` remains the source of truth; nothing in P0–P4
  writes to it, and `record_changes` stays rebuildable from it.

## 6. Open questions

1. Does the browser page member repos that belong to other spaces too, or only
   the repos this space's stream touched? (D2 assumes the latter.)
2. **Where does the space go in `RecordChange`?** Under permissioned spaces a
   repo DID alone does not address a record — the same DID holds a repo in every
   space it writes to. Either the type gains a space scope before P5, or the
   producer carries it per row.
3. Who owns the "cannot be expressed" list — an admin-only diagnostic, or a
   public per-space report that users can read before migrating?
4. What is the long-term home of the stored feed's repo assignment? D1 and D7
   keep the stored rows as they are (the space DID for edits/deletes and for
   A's grant) and resolve the repo at fold time. Revisit when clients write
   records directly, because then the row's repo and the record's repo diverge
   for a different reason.
5. **Bridged profiles (D8)** — a cutover loses them until
   `space.roomy.user.bridgedProfile` exists and the bridge writes it. Nothing
   else in this plan depends on the fix; the gap is what has to be visible.
6. **The Rust mirror does not know D7's second kind.** `crates/space-core` is a
   full parallel of the TypeScript record module: a closed 16-entry
   `KIND_NAMES` table (`src/change.rs`), bodies, patches, and per-kind rules
   (`src/rules/federation.rs`, which holds `origin` and `receiver` on one
   record). A feed row whose `kind` is `federationReceiverGrant` decodes to
   `DecodeError::UnknownKind` there — a hard error, not a skip. Nothing in CI
   catches it: the write-parity fixture
   (`crates/roomy-ingest/tests/fixtures/writes.json`) carries no grant case at
   all. Port the split and add grant cases to the fixture before the Rust
   appserver reads a feed this branch wrote.
