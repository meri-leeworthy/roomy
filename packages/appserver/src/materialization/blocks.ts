/**
 * Fetch a user's block records from their own PDS.
 *
 * Two collections are the same shape — `space.roomy.user.block` and
 * `app.bsky.graph.block`, both `{ subject, createdAt }` with a TID record key —
 * so one page loop reads both and unifies them into a single set. A block
 * written in Roomy therefore has the same standing as one imported from
 * Bluesky, and the fetch is a copy rather than a translation in either
 * direction.
 *
 * The PDS is the authoritative, pre-built index for exactly the question asked
 * here ("what are the blocks in *this one account's* repo"), so it is read
 * directly rather than through a network index. That also gives the exact
 * freshness a safety feature needs: a block written a moment ago must be
 * visible to the next read, and an eventually-consistent index cannot promise
 * that.
 *
 * The same function answers both directions of a block. A user's written set
 * is their own repo; the reverse set — everyone who blocks *this* user — is
 * recovered by running this over the repos of the other accounts, which is why
 * the cache in `queries/userBlocks.ts` is keyed by the DID whose repo was read
 * rather than by the viewer.
 *
 * Every record here is public data: atproto repositories are world-readable,
 * which is what makes the reverse direction recoverable at all.
 */

import { AtpAgent } from "@atproto/api";
import { resolvePdsEndpoint } from "../identity.ts";
import { profileFetchTimeoutMs } from "../fetchTimeout.ts";

/** The Roomy block collection — one record per block, `key: tid`. */
export const ROOMY_BLOCK_COLLECTION = "space.roomy.user.block";

/** The Bluesky block collection, bootstrapped from on a user's first read. */
export const BLUESKY_BLOCK_COLLECTION = "app.bsky.graph.block";

/** Which repo a block row was read out of. */
export type BlockSource = "roomy" | "bluesky";

/** One block, as read from a repo. */
export interface BlockRecord {
  /** DID of the blocked account. */
  subject: string;
  /** The collection the record came from. */
  source: BlockSource;
  /** The record's `createdAt`, in epoch ms, when it is a parseable datetime. */
  createdAt: number | null;
}

/** Both collections, in the order they are read. */
const COLLECTIONS: ReadonlyArray<{ id: string; source: BlockSource }> = [
  { id: ROOMY_BLOCK_COLLECTION, source: "roomy" },
  { id: BLUESKY_BLOCK_COLLECTION, source: "bluesky" },
];

/** One page of records; the PDS's own maximum, so a typical user costs one or two calls. */
const PAGE_LIMIT = 100;

// ─── Test-only override ──────────────────────────────────────────────────

/**
 * Test-only override for the PDS `listRecords` loop. When set,
 * `fetchBlockRecords` uses it instead of resolving the PDS and hitting the
 * network, so tests exercise the cache, the backoff and the mutual relation
 * hermetically.
 */
let testFetchBlockRecords:
  | ((did: string) => Promise<BlockRecord[]>)
  | null = null;

/** Set a test-only block fetcher override (or null to clear). */
export function _setTestFetchBlockRecords(
  fn: ((did: string) => Promise<BlockRecord[]>) | null,
): void {
  testFetchBlockRecords = fn;
}

// ─── Fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch every block record in `did`'s own repo, across both collections.
 *
 * Throws only when the account cannot be read at all — an unresolvable DID, an
 * unreachable or hung PDS. A collection the PDS does not serve returns an empty
 * page rather than an error, which is the common case: an account that has
 * never blocked anyone holds no `app.bsky.graph.block` records, and an account
 * that has never blocked in Roomy holds no `space.roomy.user.block` records at
 * all. Treating either as a failure would back off the account for a minute and
 * leave a just-created block unenforced, so both collapse to "no rows from this
 * collection".
 *
 * Each request carries its own deadline. The identity resolver has its own
 * (see `identity.ts`), but the record calls do not, and a PDS that accepts the
 * connection and then never answers would otherwise park the caller forever.
 */
export async function fetchBlockRecords(did: string): Promise<BlockRecord[]> {
  if (testFetchBlockRecords) return testFetchBlockRecords(did);

  const pdsEndpoint = await resolvePdsEndpoint(did);
  const agent = new AtpAgent({ service: pdsEndpoint });
  const out: BlockRecord[] = [];

  for (const collection of COLLECTIONS) {
    let cursor: string | undefined;
    do {
      let page: BlockRecordPage;
      try {
        page = await fetchRecordPage(agent, did, collection.id, cursor);
      } catch (err) {
        // An unknown collection is not a failure: the account simply has no
        // records of that type, and every read that consumes this set must not
        // be backed off for it.
        if (isUnknownCollection(err)) break;
        throw err;
      }

      for (const value of page.values) {
        const parsed = toBlockRecord(collection.source, value);
        if (parsed) out.push(parsed);
      }
      cursor = page.cursor;
    } while (cursor);
  }

  return out;
}

/** One page of a repo's records, plus the cursor that continues it. */
interface BlockRecordPage {
  /** The `value` of each `listRecords` record — the block itself, not the envelope. */
  values: unknown[];
  cursor?: string;
}

/**
 * One `listRecords` page, carrying this request's own deadline. The deadline
 * covers the response *and* the body read, so a PDS that accepts the connection
 * and then goes quiet aborts here rather than parking the caller.
 */
async function fetchRecordPage(
  agent: AtpAgent,
  did: string,
  collection: string,
  cursor: string | undefined,
): Promise<BlockRecordPage> {
  const page = await agent.com.atproto.repo.listRecords(
    {
      repo: did,
      collection,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    },
    { signal: AbortSignal.timeout(profileFetchTimeoutMs()) },
  );
  return { values: page.data.records.map((r) => r.value), cursor: page.data.cursor };
}

// ─── Record narrowing ──────────────────────────────────────────────────────

/**
 * Narrow a raw record value to a block, or null when it names no subject.
 *
 * Only `subject` is load-bearing — it is the DID the block hides. `createdAt` is
 * carried for the "when did I block this" affordance and is optional on both
 * collections, so an unparseable or absent value is a null timestamp rather
 * than a dropped record.
 */
function toBlockRecord(source: BlockSource, value: unknown): BlockRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const subject = v["subject"];
  if (typeof subject !== "string" || subject === "") return null;
  return {
    subject,
    source,
    createdAt: parseTimestamp(v["createdAt"]),
  };
}

/** Parse an atproto datetime into epoch ms, or null. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when an error means "this repo has no such collection".
 *
 * PDS implementations differ on how they say it — a 400 with
 * `InvalidRequest`, `CollectionNotFound` or `RecordNotFound` — and at least one
 * large host answers an unknown collection with an empty 200 page instead. All
 * of those collapse to the same meaning here. An error carrying no recognised
 * name is *not* matched: it might be a timeout or an outage, and swallowing one
 * of those would leave a created block silently unenforced.
 */
function isUnknownCollection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { error?: unknown; status?: unknown; message?: unknown };
  const name = typeof e.error === "string" ? e.error : "";
  const NAMES = ["InvalidRequest", "CollectionNotFound", "RecordNotFound"];
  if (NAMES.includes(name)) return true;
  // Some hosts answer with a bare 400 and no error name.
  if (e.status === 400 && name === "") return true;
  const message = typeof e.message === "string" ? e.message : "";
  // XRPC error messages read "Could not locate record: ..." / "Unknown
  // collection". Matching on the message is a last resort, so it is kept
  // narrow to the collection case.
  return /unknown collection/i.test(message);
}
