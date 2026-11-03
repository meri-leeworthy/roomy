//! The materialisation loop.
//!
//! One iteration is: hold the lease, read a batch of changes from the cursor,
//! plan it against the rows the space DB holds, hand the global half to the
//! sink, then commit the space half and the cursor in one transaction. The
//! global index may be one batch ahead of the space projection after a crash —
//! every global statement is idempotent, so the replay rewrites it — and is
//! never behind it.
//!
//! Three things it deliberately does not do:
//!
//!  * **Unread.** A reader's unread count is their read position against the
//!    room's message set, both of which are read-time facts. Nothing here
//!    accumulates it.
//!  * **Re-materialisation from the log.** The feed is the input; a worker with
//!    a stale DB resumes from its cursor and a worker with a corrupt one is
//!    rebuilt by replaying the feed from zero. A rebuild plans in
//!    [`PlanMode::Backfill`], which invalidates the read-path projections
//!    instead of maintaining them, so a database being rebuilt never answers a
//!    read from a half-replayed projection.
//!  * **Serving reads.** The router is a separate crate; this one materialises.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use space_core::change::{DecodeError, FeedRow};
use space_core::ids::SpaceDid;
use space_core::{PlanMode, RuleError};
use space_db::plan;
use space_db::{DbError, SpaceDb};
use space_feed::{ChangeFeed, Cursor, FeedError};

use crate::cancel::Cancel;
use crate::clock::Clock;
use crate::health::Health;
use crate::lease::{Lease, LeaseError, LeaseGrant};
use crate::signal::{SignalSink, SpaceSignal};
use crate::sink::{GlobalSink, SinkError};

/// What one iteration did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    /// The lease is not ours; another process owns the space.
    NotLeased,
    /// Nothing to apply, or everything available was applied and the feed is
    /// now empty.
    Idle { cursor: (i64, i64) },
    /// A batch was applied.
    Applied {
        cursor: (i64, i64),
        entries: usize,
        changes: usize,
    },
}

/// One entry of a batch, as the feed described it.
///
/// Carried into a failure so the line an operator reads names the event rather
/// than the position the cursor had when the batch was read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEvent {
    /// The log entry the change came from.
    pub idx: i64,
    /// The entry's event id.
    pub event_id: String,
    /// The collection the change's record lives in.
    pub collection: String,
    /// The record's key within that collection.
    pub rkey: String,
}

impl std::fmt::Display for BatchEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} at idx {} ({}/{})",
            self.event_id, self.idx, self.collection, self.rkey
        )
    }
}

/// The batch a failure happened on: what was being applied, in the terms the
/// log and the feed share.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BatchIdentity {
    /// The `(idx, ord)` of the batch's first row.
    pub first: (i64, i64),
    /// The `(idx, ord)` of its last row.
    pub last: (i64, i64),
    /// How many log entries the batch holds.
    pub entries: usize,
    /// How many changes it carries.
    pub changes: usize,
    /// One entry per log entry, in application order.
    pub events: Vec<BatchEvent>,
}

impl BatchIdentity {
    /// The identity of the batch read from `rows`, which must not be empty.
    ///
    /// Rows sharing an `idx` are one entry, so the events are deduplicated the
    /// same way [`space_db::plan::group_entries`] groups them.
    #[must_use]
    pub fn of(rows: &[FeedRow], entries: usize) -> Self {
        let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
            return Self {
                first: (-1, -1),
                last: (-1, -1),
                entries: 0,
                changes: 0,
                events: Vec::new(),
            };
        };
        let mut events: Vec<BatchEvent> = Vec::new();
        for row in rows {
            if events.last().is_some_and(|seen| seen.idx == row.idx) {
                continue;
            }
            events.push(BatchEvent {
                idx: row.idx,
                event_id: row.event_id.clone(),
                collection: row.collection.clone(),
                rkey: row.rkey.clone(),
            });
        }
        Self {
            first: (first.idx, first.ord),
            last: (last.idx, last.ord),
            entries,
            changes: rows.len(),
            events,
        }
    }
}

/// How many of a batch's events the human-readable form names. A batch may be
/// the whole of a space's backlog, and a line naming five hundred events is a
/// line an operator cannot read and a log cannot afford once a minute. The full
/// list stays in the identity itself, which `/health` serves.
const EVENTS_NAMED: usize = 8;

impl std::fmt::Display for BatchIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "idx {}-{} (ord {}-{}), {} entries, {} changes",
            self.first.0, self.last.0, self.first.1, self.last.1, self.entries, self.changes
        )?;
        for event in self.events.iter().take(EVENTS_NAMED) {
            write!(f, "; {event}")?;
        }
        match self.events.len().saturating_sub(EVENTS_NAMED) {
            0 => Ok(()),
            rest => write!(f, "; and {rest} more"),
        }
    }
}

/// Whether applying a batch can succeed on a later attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Retry {
    /// The batch may apply once whatever refused it clears — a lock, a busy
    /// file, a lease that moved.
    Transient,
    /// The data refuses the batch. The same rows fail the same way however
    /// often they are read again.
    Permanent,
}

/// Where a batch failed to apply.
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("{0}")]
    Sink(#[from] SinkError),
    #[error("{0}")]
    Db(#[from] DbError),
}

/// A failure raised while applying one batch, carrying that batch's identity.
#[derive(Debug, thiserror::Error)]
#[error("applying the batch at {batch}: {source}")]
pub struct ApplyFailure {
    /// The batch that was being applied.
    pub batch: BatchIdentity,
    /// Whether trying it again can ever succeed.
    pub retry: Retry,
    /// What went wrong.
    #[source]
    pub source: ApplyError,
}

impl ApplyFailure {
    /// A sink failure on `batch`.
    #[must_use]
    pub fn sink(error: SinkError, batch: BatchIdentity) -> Self {
        let SinkError::Sqlite(source) = &error;
        let retry = retry_of_sqlite(source);
        Self {
            batch,
            retry,
            source: ApplyError::Sink(error),
        }
    }

    /// A space-database failure on `batch`.
    #[must_use]
    pub fn db(error: DbError, batch: BatchIdentity) -> Self {
        let retry = error.sqlite().map_or(Retry::Transient, retry_of_sqlite);
        Self {
            batch,
            retry,
            source: ApplyError::Db(error),
        }
    }
}

/// A constraint is the data's answer, not a condition that clears: the same
/// batch rewrites the same rows and violates the same constraint. Everything
/// else — busy, locked, a full disk — may pass on the next attempt.
fn retry_of_sqlite(error: &rusqlite::Error) -> Retry {
    match error {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Retry::Permanent
        }
        _ => Retry::Transient,
    }
}

/// A loop failure.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("{0}")]
    Feed(#[from] FeedError),
    #[error("{0}")]
    Lease(#[from] LeaseError),
    #[error("{0}")]
    Sink(#[from] SinkError),
    #[error("{0}")]
    Db(#[from] DbError),
    /// The batch identity is carried by box: it holds the entries' events, and
    /// an error variant that costs a batch's worth of memory on every `Result`
    /// is paid for by the success path too.
    #[error("{0}")]
    Apply(Box<ApplyFailure>),
    #[error("change at idx {idx} does not decode: {source}")]
    Decode { idx: i64, source: DecodeError },
    #[error("planning batch at idx {idx}: {source}")]
    Plan { idx: i64, source: RuleError },
    #[error("starting an actor: {0}")]
    Spawn(String),
    /// The lease moved to another worker while this batch was in flight, so the
    /// batch was refused rather than written over the new owner's projection.
    #[error("fenced out at epoch {granted} (stored {stored})")]
    Fenced { granted: i64, stored: i64 },
}

/// What a worker is built from: the four seams, the space it owns, and the
/// policy of the loop itself.
pub struct WorkerParts<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> {
    /// The space this worker owns.
    pub space: SpaceDid,
    /// This process's identity on the lease row.
    pub holder: String,
    /// How long a claim stays valid without renewal.
    pub lease_ttl: Duration,
    /// The most changes one batch may hold.
    pub batch_limit: usize,
    /// Whether this worker is the live write path or a rebuild. A rebuild
    /// invalidates the read-path projections rather than writing them.
    pub mode: PlanMode,
    /// The change records to apply.
    pub feed: F,
    /// Whether this process may write the space.
    pub lease: L,
    /// Where each change's global statements go.
    pub sink: S,
    /// Where the post-commit signals go.
    pub signals: N,
    /// The lease's instants.
    pub clock: Arc<dyn Clock>,
    /// The supervisor's stop signal for this space.
    pub cancel: Cancel,
    /// Whether this worker replays beside the owner instead of owning the
    /// space. Its lease claims nothing, so its health reports no lease rather
    /// than the answer `acquire` gives.
    pub following: bool,
    /// The space's projection.
    pub db: SpaceDb,
}

/// The materialisation loop for one space.
pub struct Worker<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> {
    space: SpaceDid,
    holder: String,
    lease_ttl: Duration,
    batch_limit: usize,
    mode: PlanMode,
    feed: F,
    lease: L,
    sink: S,
    signals: N,
    clock: Arc<dyn Clock>,
    cancel: Cancel,
    following: bool,
    db: SpaceDb,
    /// The last failure, for `/health`. A failed batch leaves the cursor where
    /// it was, so the next iteration retries it.
    last_error: Option<String>,
}

impl<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> Worker<F, L, S, N> {
    /// A worker over `parts`.
    #[must_use]
    pub fn new(parts: WorkerParts<F, L, S, N>) -> Self {
        Self {
            space: parts.space,
            holder: parts.holder,
            lease_ttl: parts.lease_ttl,
            batch_limit: parts.batch_limit,
            mode: parts.mode,
            feed: parts.feed,
            lease: parts.lease,
            sink: parts.sink,
            signals: parts.signals,
            clock: parts.clock,
            cancel: parts.cancel,
            db: parts.db,
            following: parts.following,
            last_error: None,
        }
    }

    /// The space's projection, as this worker sees it.
    pub fn space_db(&self) -> &SpaceDb {
        &self.db
    }

    /// The last batch failure, until a batch succeeds.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// What this worker plans in: the live path, or a rebuild's backfill.
    #[must_use]
    pub fn mode(&self) -> PlanMode {
        self.mode
    }

    /// Switch between the live path and a rebuild. A supervisor sets this while
    /// a space is being replayed from zero and clears it once the replay has
    /// caught up to the feed.
    pub fn set_mode(&mut self, mode: PlanMode) {
        self.mode = mode;
    }

    /// Whether this process holds the lease right now, and under which epoch.
    pub fn holds_lease(&mut self) -> Result<LeaseGrant, WorkerError> {
        Ok(self.lease.acquire(
            &self.space,
            &self.holder,
            self.clock.now_ms(),
            self.lease_ttl,
        )?)
    }

    /// The supervisor's stop signal for this space.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The cursor the projection has been advanced to.
    pub fn cursor(&self) -> Result<(i64, i64), WorkerError> {
        Ok(self.db.cursor()?.unwrap_or((-1, -1)))
    }

    /// How many log entries the space has beyond the applied cursor.
    pub fn lag(&mut self) -> Result<i64, WorkerError> {
        let latest = self.feed.latest_idx(&self.space)?;
        let (idx, _) = self.cursor()?;
        Ok((latest - idx).max(0))
    }

    /// One iteration of the loop.
    pub fn step(&mut self) -> Result<Progress, WorkerError> {
        match self.run_step() {
            Ok(progress) => {
                self.last_error = None;
                Ok(progress)
            }
            Err(error) => {
                self.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    fn run_step(&mut self) -> Result<Progress, WorkerError> {
        if self.cancel.is_cancelled() {
            return Ok(Progress::Idle {
                cursor: self.db.cursor()?.unwrap_or((-1, -1)),
            });
        }
        let grant = self.lease.acquire(
            &self.space,
            &self.holder,
            self.clock.now_ms(),
            self.lease_ttl,
        )?;
        if !grant.held {
            return Ok(Progress::NotLeased);
        }

        let cursor = self.db.cursor()?.unwrap_or((-1, -1));
        let rows = self
            .feed
            .batch(&self.space, Cursor::from(cursor), self.batch_limit)?;
        if rows.is_empty() {
            return Ok(Progress::Idle { cursor });
        }

        let entries = plan::group_entries(&rows).map_err(|error| WorkerError::Decode {
            idx: error.idx,
            source: error.source,
        })?;
        let changes = rows.len();

        let planned = plan::plan_batch(self.db.connection(), &self.space, &entries, self.mode)
            .map_err(|source| match source {
                DbError::Rule(source) => WorkerError::Plan {
                    idx: entries.first().map(|entry| entry.idx).unwrap_or(-1),
                    source,
                },
                other => WorkerError::Db(other),
            })?;

        let last = rows.last().expect("a non-empty batch has a last row");
        let next_cursor = (last.idx, last.ord);
        // What every failure past this point names: the batch, not the cursor
        // it was read from, which on a space that has never applied anything is
        // the same `(-1, -1)` for every batch it will ever fail on.
        let batch_id = BatchIdentity::of(&rows, entries.len());

        // The global half goes first: it is idempotent, so a crash between the
        // two databases replays harmlessly, and writing it first is what keeps
        // the index from ever being behind a committed space projection. The
        // space half stays uncommitted until the sink has accepted, so a sink
        // failure leaves the cursor where it was and the same changes are read
        // again.
        let batch = self
            .db
            .begin_batch(&planned, next_cursor, grant.epoch)
            .map_err(|error| match error {
                DbError::Fenced { granted, stored } => WorkerError::Fenced { granted, stored },
                other => WorkerError::Apply(Box::new(ApplyFailure::db(other, batch_id.clone()))),
            })?;
        self.sink.apply(batch.globals()).map_err(|error| {
            WorkerError::Apply(Box::new(ApplyFailure::sink(error, batch_id.clone())))
        })?;
        batch
            .commit()
            .map_err(|error| WorkerError::Apply(Box::new(ApplyFailure::db(error, batch_id))))?;
        // After the commit: a listener that reacts to this signal reads the
        // rows it is about.
        self.signals.signal(&SpaceSignal {
            space: self.space.clone(),
            cursor: next_cursor,
            entries: entries.len(),
        });

        Ok(Progress::Applied {
            cursor: next_cursor,
            entries: entries.len(),
            changes,
        })
    }

    /// Give the lease back, if this process still holds it, and flush anything
    /// the signal sink is holding.
    pub fn release(&mut self) {
        if let Err(error) = self.lease.release(&self.space, &self.holder) {
            tracing::warn!(%error, "releasing the lease");
        }
        self.signals.flush();
    }

    /// What `/health` reports.
    pub fn health(&mut self) -> Health {
        let cursor = self.cursor().unwrap_or((-1, -1));
        let lag = self.lag().unwrap_or(-1);
        // A follower holds no lease, and asking for one is a write to a table it
        // does not own. Report what is true instead of acquiring it.
        let lease_held = if self.following {
            false
        } else {
            self.holds_lease().map(|grant| grant.held).unwrap_or(false)
        };
        Health {
            space: self.space.as_str().to_string(),
            cursor,
            lag,
            lease_held,
            following: self.following,
            holder: self.holder.clone(),
            last_error: self.last_error.clone(),
            // Whether a batch was given up on is the retry loop's fact, not the
            // worker's: it is set by the supervisor that owns the attempts.
            poisoned: None,
        }
    }
}
