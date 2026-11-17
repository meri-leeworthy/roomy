//! The supervisor: one process, several spaces.
//!
//! The gate this file exists for is the M1 gate: a process materialises N spaces
//! and stops cleanly. The log is the fixture corpus, replayed under three
//! different space DIDs, so the projections it compares are the ones the
//! TypeScript rules produce from that corpus.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use roomy_space_worker::health::Health;
use roomy_space_worker::sink::{GlobalSink, SinkError, SqliteGlobalSink};
use roomy_space_worker::supervisor::PERMANENT_ATTEMPT_LIMIT;
use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::effects::SqlEffect;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};
use space_feed::{ChangeFeed, Cursor, FeedError};

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The events database: the fixture's rows, once per space.
fn build_events_db(path: &Path, spaces: &[SpaceDid]) {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let conn = rusqlite::Connection::open(path).expect("events DB");
    conn.execute_batch(
        "create table record_changes (
           stream_id text not null,
           idx integer not null,
           ord integer not null,
           kind text not null,
           repo text not null,
           collection text not null,
           rkey text not null,
           op text not null,
           order_stamp text not null,
           actor text not null,
           event_id text not null,
           body text,
           primary key (stream_id, idx, ord)
         ) strict;",
    )
    .expect("schema");
    for space in spaces {
        for row in &fixture.changes {
            conn.execute(
                "insert into record_changes (
                   stream_id, idx, ord, kind, repo, collection, rkey, op,
                   order_stamp, actor, event_id, body
                 ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    space.as_str(),
                    row["idx"].as_i64(),
                    row["ord"].as_i64(),
                    row["kind"].as_str(),
                    row["repo"].as_str(),
                    row["collection"].as_str(),
                    row["rkey"].as_str(),
                    row["op"].as_str(),
                    row["orderStamp"].as_str(),
                    row["actor"].as_str(),
                    row["eventId"].as_str(),
                    row["body"].as_str(),
                ],
            )
            .expect("inserting a feed row");
        }
    }
}

fn config(dir: &Path) -> SupervisorConfig {
    SupervisorConfig {
        events_db: dir.join("events.sqlite"),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: "supervisor-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    }
}

fn digest_of_space(path: &Path, space: &SpaceDid) -> String {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    digest_of(&worker_snapshot(
        &snapshot_db(db.connection()).expect("snapshot"),
    ))
}

/// Each table's row count, which is what two spaces holding the same log agree
/// on: the rows themselves name the space, so their columns differ by design.
fn shape_of_space(path: &Path, space: &SpaceDid) -> Vec<(String, usize)> {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    let snapshot = worker_snapshot(&snapshot_db(db.connection()).expect("snapshot"));
    snapshot
        .into_iter()
        .map(|table| (table.table, table.rows.len()))
        .collect()
}

/// Wait until every space's cursor has reached the last entry in its feed.
fn wait_for_catch_up(config: &SupervisorConfig, spaces: &[SpaceDid], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let mut ready = 0;
        for space in spaces {
            let db = SpaceDb::open(config.space_path(space), space.clone()).expect("space DB");
            let latest: i64 = {
                let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
                conn.query_row(
                    "select max(idx) from record_changes where stream_id = ?",
                    [space.as_str()],
                    |row| row.get(0),
                )
                .expect("latest idx")
            };
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx >= latest {
                    ready += 1;
                }
            }
        }
        if ready == spaces.len() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor did not drain {ready}/{} spaces in time",
            spaces.len()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn one_process_materialises_several_spaces_and_stops_them_cleanly() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spaces: Vec<SpaceDid> = [
        "did:web:first.example",
        "did:web:second.example",
        "did:web:third.example",
    ]
    .iter()
    .map(|did| SpaceDid::parse(did.to_string()).expect("space DID"))
    .collect();
    let config = config(dir.path());
    build_events_db(&config.events_db, &spaces);

    let supervisor = Supervisor::start(config.clone(), spaces.clone()).expect("supervisor starts");
    wait_for_catch_up(&config, &spaces, Duration::from_secs(20));

    // Every space's projection is the corpus's: the three hold the same rows,
    // table for table. The rows themselves name the space, so their columns
    // differ by design and the comparison is the shape each projection has.
    let shapes: Vec<Vec<(String, usize)>> = spaces
        .iter()
        .map(|space| shape_of_space(&config.space_path(space), space))
        .collect();
    assert!(
        shapes[0].iter().any(|(_, rows)| *rows > 0),
        "the log wrote rows"
    );
    assert_eq!(shapes[0], shapes[1]);
    assert_eq!(shapes[1], shapes[2]);
    let digests: Vec<String> = spaces
        .iter()
        .map(|space| digest_of_space(&config.space_path(space), space))
        .collect();

    // Health is per space, and each actor reports the lease it holds.
    let health = supervisor.health();
    assert_eq!(health.len(), 3, "one health row per running actor");
    assert!(health.iter().all(|health| health.lease_held));
    assert!(health.iter().all(|health| health.lag == 0));
    assert_eq!(supervisor.spaces().len(), 3);

    // Stopping gives the leases back: another process can take them at once.
    supervisor.stop();
    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let held: i64 = global
        .query_row("select count(*) from worker_leases", [], |row| row.get(0))
        .expect("lease count");
    assert_eq!(held, 0, "stopping must release every lease");

    // The projections survive the stop.
    let after: Vec<String> = spaces
        .iter()
        .map(|space| digest_of_space(&config.space_path(space), space))
        .collect();
    assert_eq!(after, digests);
}

#[test]
fn stopping_one_space_leaves_the_others_running() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spaces: Vec<SpaceDid> = ["did:web:keep.example", "did:web:drop.example"]
        .iter()
        .map(|did| SpaceDid::parse(did.to_string()).expect("space DID"))
        .collect();
    let config = config(dir.path());
    build_events_db(&config.events_db, &spaces);

    let supervisor = Supervisor::start(config.clone(), spaces.clone()).expect("supervisor starts");
    wait_for_catch_up(&config, &spaces, Duration::from_secs(20));

    supervisor.stop_space(&spaces[1]);
    assert_eq!(supervisor.spaces(), vec![spaces[0].as_str().to_string()]);

    // The survivor keeps its lease; the stopped space's is released.
    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let lease = |space: &SpaceDid| -> Option<String> {
        global
            .query_row(
                "select holder from worker_leases where name = ?",
                [format!("space-worker:{space}")],
                |row| row.get(0),
            )
            .ok()
    };
    assert_eq!(lease(&spaces[0]).as_deref(), Some("supervisor-test"));
    assert_eq!(lease(&spaces[1]), None);

    supervisor.stop();
}

/// A feed whose every read fails, counting the reads it was asked for: what a
/// space does when the log itself is unreadable or an event cannot be planned.
struct FailingFeed {
    attempts: Arc<AtomicUsize>,
}

impl ChangeFeed for FailingFeed {
    fn batch(
        &self,
        _space: &SpaceDid,
        _cursor: Cursor,
        _limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        Err(FeedError::Decode("the first row does not decode".into()))
    }

    fn latest_idx(&self, _space: &SpaceDid) -> Result<i64, FeedError> {
        Ok(0)
    }

    fn streams(&self) -> Result<Vec<SpaceDid>, FeedError> {
        Err(FeedError::Decode("the log cannot be read".into()))
    }
}

/// A space that cannot make progress waits between attempts, and `/health` says
/// what failed. Without the wait the loop retries as fast as SQLite answers —
/// thousands of attempts a second, one busy core per broken space.
#[test]
fn a_failing_space_retries_under_a_backoff_and_reports_the_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    let space = SpaceDid::parse("did:web:broken.example".to_string()).expect("space DID");
    let config = config(dir.path());
    let attempts = Arc::new(AtomicUsize::new(0));

    let counted = Arc::clone(&attempts);
    let supervisor = Supervisor::new(config).with_feed(Arc::new(move || {
        Ok(Box::new(FailingFeed {
            attempts: Arc::clone(&counted),
        }) as Box<dyn ChangeFeed>)
    }));
    supervisor
        .start_all([space])
        .expect("the actor starts despite a failing feed");

    let window = Duration::from_secs(2);
    std::thread::sleep(window);
    let made = attempts.load(Ordering::Relaxed);
    let health = supervisor.health();

    // A stop joins the actor thread: it must not wait out a backoff.
    let stopping = Instant::now();
    supervisor.stop();
    assert!(
        stopping.elapsed() < Duration::from_secs(1),
        "stopping took {:?}: the loop slept out its backoff",
        stopping.elapsed()
    );

    // 250 ms, then 500 ms, then 1 s: a handful of attempts in two seconds. A
    // loop with no wait makes thousands, which is what this bound rejects.
    assert!(
        made >= 2,
        "the space gave up instead of retrying: {made} attempts in {window:?}"
    );
    assert!(
        made <= 30,
        "the space retried {made} times in {window:?}: the loop is spinning"
    );

    assert_eq!(health.len(), 1, "one health row for the failing space");
    let error = health[0]
        .last_error
        .as_deref()
        .expect("the health snapshot carries the failure");
    assert!(
        error.contains("does not decode"),
        "the health snapshot names the error, got {error:?}"
    );
    assert!(!health[0].is_healthy());
}

/// The error SQLite raises for a foreign key a batch violates, built from the
/// extended code SQLite itself reports, so the classifier sees the shape
/// production sees.
fn constraint_violation() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(787),
        Some("FOREIGN KEY constraint failed".to_string()),
    )
}

/// The error SQLite raises when another writer holds the file: the class that
/// must keep retrying.
fn database_busy() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(5),
        Some("database is locked".to_string()),
    )
}

/// A sink whose every apply fails the way `error` says, counting the attempts.
struct RefusingSink {
    attempts: Arc<AtomicUsize>,
    error: fn() -> rusqlite::Error,
}

impl GlobalSink for RefusingSink {
    fn apply(&mut self, _statements: &[SqlEffect]) -> Result<(), SinkError> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        Err(SinkError::Sqlite((self.error)()))
    }
}

/// A sink that refuses its first `failures` batches and then writes to the
/// global database: a failure the data recovers from.
struct RecoveringSink {
    failures: usize,
    attempts: Arc<AtomicUsize>,
    inner: SqliteGlobalSink,
}

impl GlobalSink for RecoveringSink {
    fn apply(&mut self, statements: &[SqlEffect]) -> Result<(), SinkError> {
        let attempt = self.attempts.fetch_add(1, Ordering::Relaxed);
        if attempt < self.failures {
            return Err(SinkError::Sqlite(constraint_violation()));
        }
        self.inner.apply(statements)
    }
}

/// The process's log lines, as the format layer wrote them.
#[derive(Clone, Default)]
struct Captured(Arc<std::sync::Mutex<Vec<u8>>>);

impl Captured {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("log buffer")).into_owned()
    }
}

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn corpus() -> Fixture {
    serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
        .expect("fixture parses")
}

/// Wait for the space's health row to say it was poisoned.
fn wait_for_poison(supervisor: &Supervisor, space: &SpaceDid) -> Health {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let health = supervisor
            .health()
            .into_iter()
            .find(|health| health.space == space.as_str());
        if let Some(health) = health {
            if health.poisoned.is_some() {
                return health;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the actor never gave up on the batch it cannot apply"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A constraint violation is the data's answer: the same batch violates it
/// every time. The actor attempts it the permitted number of times, then
/// records what it could not apply and stops — instead of retrying a batch that
/// can never land, once a minute, forever.
#[test]
fn a_batch_the_data_refuses_poisons_the_space_and_names_its_events() {
    let dir = tempfile::tempdir().expect("temp dir");
    let space = SpaceDid::parse("did:web:poisoned.example".to_string()).expect("space DID");
    let config = config(dir.path());
    build_events_db(&config.events_db, std::slice::from_ref(&space));
    // The batch limit is the whole corpus, so the failing batch is every entry
    // the corpus holds and its identity is what `/health` reports.
    let corpus = corpus();
    let first = corpus.changes.first().expect("the corpus has changes");

    let captured = Captured::default();
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(captured.clone())
        .try_init();

    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&attempts);
    let supervisor = Supervisor::new(config.clone()).with_sink(Arc::new(move || {
        Ok(Box::new(RefusingSink {
            attempts: Arc::clone(&counted),
            error: constraint_violation,
        }) as Box<dyn GlobalSink>)
    }));
    supervisor
        .start_all([space.clone()])
        .expect("the actor starts");

    let health = wait_for_poison(&supervisor, &space);

    let poison = health.poisoned.clone().expect("the health row is poisoned");
    assert_eq!(
        poison.attempts, PERMANENT_ATTEMPT_LIMIT,
        "the actor gave up after a different number of attempts than its bound"
    );
    assert_eq!(
        attempts.load(Ordering::Relaxed) as u32,
        PERMANENT_ATTEMPT_LIMIT,
        "every attempt is one apply"
    );
    let event = poison
        .batch
        .events
        .first()
        .expect("the batch names its entries");
    assert_eq!(event.event_id, first["eventId"].as_str().expect("event id"));
    assert_eq!(
        event.collection,
        first["collection"].as_str().expect("collection")
    );
    assert_eq!(event.rkey, first["rkey"].as_str().expect("rkey"));
    assert_eq!(
        poison.batch.first,
        (
            first["idx"].as_i64().expect("idx"),
            first["ord"].as_i64().expect("ord")
        )
    );
    assert_eq!(
        poison.batch.changes,
        corpus.changes.len(),
        "the batch that failed is the whole corpus"
    );
    assert_eq!(health.cursor, (-1, -1), "no batch was ever applied");
    assert!(!health.is_healthy(), "a poisoned space is not healthy");
    assert!(
        health
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains(&event.event_id)),
        "the health error names the event: {:?}",
        health.last_error
    );

    // The object `/health` serves, not just the struct.
    let body = health.to_value();
    assert_eq!(body["poisoned"], serde_json::json!(true));
    assert_eq!(
        body["poison"]["attempts"],
        serde_json::json!(PERMANENT_ATTEMPT_LIMIT)
    );
    assert_eq!(
        body["poison"]["batch"]["events"][0]["eventId"],
        serde_json::json!(event.event_id)
    );

    // The line an operator reads names the event, not the cursor the batch was
    // read from: `(-1, -1)` is every position this space will ever be stuck at.
    // The subscriber is the process's, so it holds the other tests' spaces too.
    let log = captured.text();
    let event_id = first["eventId"].as_str().expect("event id");
    let failure_lines: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("batch failed") && line.contains(space.as_str()))
        .collect();
    assert!(!failure_lines.is_empty(), "no failure line: {log}");
    assert!(
        failure_lines.iter().all(|line| line.contains(event_id)
            && line.contains(first["collection"].as_str().expect("collection"))
            && line.contains(first["rkey"].as_str().expect("rkey"))),
        "a failure line does not name the event: {failure_lines:?}"
    );
    assert!(
        failure_lines.iter().all(|line| line.len() < 4096),
        "a failure line is batch-sized: {} bytes",
        failure_lines
            .iter()
            .map(|line| line.len())
            .max()
            .unwrap_or(0)
    );
    assert!(
        log.lines()
            .any(|line| line.contains("poisoned until restart") && line.contains(space.as_str())),
        "giving up is its own line: {log}"
    );

    // Given up means given up: no further attempt reaches the sink.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        attempts.load(Ordering::Relaxed) as u32,
        PERMANENT_ATTEMPT_LIMIT,
        "the poisoned space is still retrying"
    );

    // And stopping it is not held up by a wait it no longer needs.
    let stopping = Instant::now();
    supervisor.stop();
    assert!(
        stopping.elapsed() < Duration::from_secs(1),
        "stopping took {:?}",
        stopping.elapsed()
    );
}

/// A busy database is not the data's answer: it can clear, so the space keeps
/// attempting it under the backoff and is never poisoned.
#[test]
fn a_busy_database_keeps_retrying_and_never_poisons() {
    let dir = tempfile::tempdir().expect("temp dir");
    let space = SpaceDid::parse("did:web:busy.example".to_string()).expect("space DID");
    let config = config(dir.path());
    build_events_db(&config.events_db, std::slice::from_ref(&space));

    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&attempts);
    let supervisor = Supervisor::new(config.clone()).with_sink(Arc::new(move || {
        Ok(Box::new(RefusingSink {
            attempts: Arc::clone(&counted),
            error: database_busy,
        }) as Box<dyn GlobalSink>)
    }));
    supervisor
        .start_all([space.clone()])
        .expect("the actor starts");

    let window = Duration::from_secs(4);
    std::thread::sleep(window);
    let made = attempts.load(Ordering::Relaxed);
    assert!(
        made > PERMANENT_ATTEMPT_LIMIT as usize,
        "a transient failure stopped the attempts: {made} in {window:?}"
    );

    let health = supervisor
        .health()
        .into_iter()
        .find(|health| health.space == space.as_str())
        .expect("a health row for the space");
    assert!(
        health.poisoned.is_none(),
        "a lock the next attempt may find clear was treated as permanent"
    );
    assert_eq!(health.to_value()["poisoned"], serde_json::json!(false));
    assert!(health.last_error.is_some(), "the failure is still reported");
    assert!(!health.is_healthy());

    supervisor.stop();
}

/// A batch that applies after a failure leaves both the error and any poison
/// behind, and the projection carries on from it.
#[test]
fn a_batch_that_applies_clears_the_failure() {
    let dir = tempfile::tempdir().expect("temp dir");
    let space = SpaceDid::parse("did:web:recovers.example".to_string()).expect("space DID");
    let config = config(dir.path());
    build_events_db(&config.events_db, std::slice::from_ref(&space));

    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&attempts);
    let global_db = config.global_db.clone();
    let supervisor = Supervisor::new(config.clone()).with_sink(Arc::new(move || {
        Ok(Box::new(RecoveringSink {
            // Below the bound: the actor is still retrying when the data stops
            // refusing the batch, which is the case a poisoned space cannot
            // reach — a poisoned actor has no attempt left to recover with.
            failures: (PERMANENT_ATTEMPT_LIMIT - 1) as usize,
            attempts: Arc::clone(&counted),
            inner: SqliteGlobalSink::open(&global_db)?,
        }) as Box<dyn GlobalSink>)
    }));
    supervisor
        .start_all([space.clone()])
        .expect("the actor starts");

    wait_for_catch_up(
        &config,
        std::slice::from_ref(&space),
        Duration::from_secs(20),
    );

    assert!(
        attempts.load(Ordering::Relaxed) >= PERMANENT_ATTEMPT_LIMIT as usize,
        "the space never failed before it applied"
    );
    let health = supervisor
        .health()
        .into_iter()
        .find(|health| health.space == space.as_str())
        .expect("a health row for the space");
    assert_eq!(
        health.last_error, None,
        "the applied batch cleared the error"
    );
    assert_eq!(health.poisoned, None, "and left no poison behind");
    assert!(health.is_healthy());
    assert!(
        health.cursor.0 >= 0,
        "the projection advanced past the failure"
    );

    supervisor.stop();
}
