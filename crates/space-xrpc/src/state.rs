//! Server state: the space database a request resolves to, a caller verifier,
//! and the optional global-store replica.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::registry::SpaceResolver;
use crate::store::{GlobalStores, NoGlobalStores};
use crate::verify::CallerVerifier;

/// A per-space SQLite database, opened read-only.
///
/// The worker serves reads only: materialisation is another component's job.
/// A small pool of read-only connections stands in for one: each query takes
/// the next, so readers do not queue behind each other, and none of them is the
/// writer's connection.
pub struct SpaceReadDb {
    connections: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl SpaceReadDb {
    pub fn open_readonly(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
        Self::open_pooled(path, 1)
    }

    /// Open `pool_size` read-only connections to `path`.
    pub fn open_pooled(
        path: impl AsRef<std::path::Path>,
        pool_size: usize,
    ) -> rusqlite::Result<Self> {
        let mut connections = Vec::with_capacity(pool_size.max(1));
        for _ in 0..pool_size.max(1) {
            let conn = Connection::open_with_flags(
                path.as_ref(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            // A reader may retry a lock rather than fail a request.
            conn.busy_timeout(std::time::Duration::from_millis(2000))?;
            connections.push(Mutex::new(conn));
        }
        Ok(Self {
            connections,
            next: AtomicUsize::new(0),
        })
    }

    /// Open an in-memory database for tests: the caller has already built the
    /// schema on it.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            connections: vec![Mutex::new(conn)],
            next: AtomicUsize::new(0),
        }
    }

    pub fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, crate::error::XrpcError>,
    ) -> Result<T, crate::error::XrpcError> {
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.connections.len();
        let conn = self.connections[index]
            .lock()
            .map_err(|_| crate::error::XrpcError::internal("database lock poisoned"))?;
        f(&conn)
    }
}

#[derive(Clone)]
pub struct XrpcState {
    /// The space this request resolved to. A per-request value: dispatch
    /// resolves it from the registry before a handler runs.
    pub db: Arc<SpaceReadDb>,
    /// Where a request's space comes from, for the router's dispatch.
    pub spaces: Arc<dyn SpaceResolver>,
    pub stores: Arc<dyn GlobalStores>,
    pub verifier: Arc<dyn CallerVerifier>,
}

impl XrpcState {
    pub fn new(db: Arc<SpaceReadDb>, verifier: Arc<dyn CallerVerifier>) -> Self {
        let spaces = Arc::new(crate::registry::FixedSpaces::new(std::iter::empty()));
        Self {
            db,
            spaces,
            stores: Arc::new(NoGlobalStores),
            verifier,
        }
    }

    /// The same state, resolving requests through `spaces`.
    pub fn with_spaces(mut self, spaces: Arc<dyn SpaceResolver>) -> Self {
        self.spaces = spaces;
        self
    }

    pub fn with_stores(mut self, stores: Arc<dyn GlobalStores>) -> Self {
        self.stores = stores;
        self
    }

    /// The same state, bound to one resolved space.
    pub fn for_space(&self, db: Arc<SpaceReadDb>) -> Self {
        Self {
            db,
            spaces: Arc::clone(&self.spaces),
            stores: Arc::clone(&self.stores),
            verifier: Arc::clone(&self.verifier),
        }
    }
}

impl std::fmt::Debug for XrpcState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XrpcState").finish_non_exhaustive()
    }
}
