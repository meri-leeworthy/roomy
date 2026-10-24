//! The post-commit signal: what a worker tells the gateway it changed.
//!
//! A signal is advisory (`rust-core-appserver.md` §2.1). It says "this space
//! moved"; it never carries the rows, and dropping one only delays freshness
//! until the next refetch or reconnect. That is why it is coarse enough to
//! coalesce and cheap enough to send after every committed batch.

use space_core::ids::SpaceDid;

/// One space's committed progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceSignal {
    pub space: SpaceDid,
    /// The cursor the projection has reached.
    pub cursor: (i64, i64),
    /// Log entries applied by the batch that produced this signal.
    pub entries: usize,
}

/// Where a worker's signals go.
pub trait SignalSink: Send {
    /// A batch committed. Called after the commit, so a listener that reads the
    /// space sees the rows the signal is about.
    fn signal(&mut self, signal: &SpaceSignal);

    /// The worker is stopping: deliver anything still held.
    fn flush(&mut self) {}
}

/// A sink that drops every signal, for a worker whose gateway polls instead.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSignals;

impl SignalSink for NoSignals {
    fn signal(&mut self, _signal: &SpaceSignal) {}
}
