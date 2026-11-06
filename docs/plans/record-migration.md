# Record-shaped output and the space record browser

Status: draft for review — 2026-11-06. Nothing here is dispatched or
implemented; phases 0–4 are unblocked, phase 5 waits on per-repo write
permissions. Companion: `packages/appserver/docs/plans/replicable-space-workers.md`
§5 WS3 (the change-record interface this builds on).

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
lexicon does not declare.

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

### P5 — Export and publish (blocked)

Not in scope until writes into user repos are possible:

- Space-repo records are writable **today**, provided the one-time migration
  ran for the space: it leaves a live PDS account and its password on file. A
  `createRecord` dry run with `validate: true` is the cheapest way to prove the
  P2 shapes against a real PDS, and it is optional.
- User-repo records need delegated/permissioned writes. Until then, the export
  is a per-repo JSONL plus a CAR (add `@atproto/repo`) that an operator can
  import; blobs need an upload step that turns `$bytes` into a blob ref.

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
2. Do we keep the interim repo assignment in the stored feed, or change the
   adapter so stored rows already carry the folded repo? Changing it is cheap
   now and expensive after a second consumer exists.
3. Who owns the "cannot be expressed" list — an admin-only diagnostic, or a
   public per-space report that users can read before migrating?
