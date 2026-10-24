//! The gateway: HTTP, WebSocket, and the seams they compose.
//!
//! What the gateway owns, and what it deliberately hands outward:
//!
//!  * **Routing.** A request names a space — directly by `spaceId`, or through a
//!    room or message id — and the gateway resolves it to the worker that serves
//!    it ([`space_xrpc::registry`]). The per-space handlers are the worker's and
//!    are unchanged.
//!  * **Tickets.** [`roomy_auth`] mints and verifies the signed connection
//!    ticket, so any gateway can accept a socket with no process-local state.
//!  * **The connection plane.** [`roomy_sync::SessionCore`] decides who hears
//!    what; this crate is the axum skin that turns its commands into frames.
//!  * **Health and metrics.** One process's view of its spaces and sessions.
//!
//! It is the same composition whether the workers live in this process or
//! another: the embedded mode reads the same registry and the same signals as a
//! split one.

pub mod cache;
pub mod reads;
pub mod signals;
pub mod ws;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use roomy_auth::{TicketIssuer, TicketVerifier};
use roomy_sync::SessionCore;
use space_xrpc::state::XrpcState;

pub use signals::GatewaySignals;

/// What the gateway is made of.
pub struct GatewayState {
    /// The per-space read router, resolving requests through the registry.
    pub reads: XrpcState,
    pub tickets: Arc<TicketIssuer>,
    pub verifier: Arc<TicketVerifier>,
    /// The connection plane. A mutex because every handler mutates it; the
    /// critical sections are map operations.
    pub sessions: Arc<Mutex<SessionCore>>,
    /// Signals from the workers in this process.
    pub signals: GatewaySignals,
    pub counters: Arc<Counters>,
    /// Answers to repeat, bounded by a TTL and evicted by signals.
    pub cache: Arc<cache::ResponseCache>,
}

/// The numbers `/metrics` reports.
#[derive(Debug, Default)]
pub struct Counters {
    pub tickets_issued: AtomicU64,
    pub sessions_opened: AtomicU64,
    pub sessions_closed: AtomicU64,
    pub frames_sent: AtomicU64,
    pub signals_received: AtomicU64,
}

impl Counters {
    pub fn snapshot(&self) -> Vec<(String, u64)> {
        vec![
            (
                "roomy_gateway_tickets_issued".to_string(),
                self.tickets_issued.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_sessions_opened".to_string(),
                self.sessions_opened.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_sessions_closed".to_string(),
                self.sessions_closed.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_frames_sent".to_string(),
                self.frames_sent.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_signals_received".to_string(),
                self.signals_received.load(Ordering::Relaxed),
            ),
        ]
    }
}

impl GatewayState {
    pub fn new(
        reads: XrpcState,
        tickets: Arc<TicketIssuer>,
        verifier: Arc<TicketVerifier>,
        signals: GatewaySignals,
    ) -> Self {
        Self {
            reads,
            tickets,
            verifier,
            sessions: Arc::new(Mutex::new(SessionCore::new())),
            signals,
            counters: Arc::new(Counters::default()),
            cache: Arc::new(cache::ResponseCache::new(Duration::from_millis(2000))),
        }
    }
}

impl std::fmt::Debug for GatewayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayState").finish_non_exhaustive()
    }
}

/// The gateway's routes: health, metrics, a ticket, the socket plane, and the
/// per-space reads the worker serves.
pub fn router(state: Arc<GatewayState>) -> Router {
    // The per-space reads are the worker's router, mounted as they are: the
    // gateway adds the edge, not a second implementation of the queries.
    // The per-space reads, behind the response cache: a repeated read for the
    // same caller and params is served from it until a signal for its space
    // evicts it or its TTL runs out.
    let reads =
        space_xrpc::router(state.reads.clone()).layer(axum::middleware::from_fn_with_state(
            std::sync::Arc::clone(&state),
            cache::middleware::cached,
        ));
    // The gateway's own routes first, then the worker's per-space reads. The
    // socket and ticket routes are static paths, so they win over the worker's
    // `/xrpc/{nsid}` catch-all.
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route(
            "/xrpc/space.roomy.auth.getConnectionTicket",
            post(get_connection_ticket),
        )
        .route("/xrpc/space.roomy.sync.subscribe", get(ws::subscribe))
        .with_state(state)
        .merge(reads)
}

async fn health(State(state): State<Arc<GatewayState>>) -> Response {
    let sessions = state
        .sessions
        .lock()
        .map(|sessions| sessions.sessions())
        .unwrap_or(0);
    Json(json!({
        "status": "ok",
        "sessions": sessions,
        "signals": state.signals.subscriber_count(),
    }))
    .into_response()
}

async fn metrics(State(state): State<Arc<GatewayState>>) -> Response {
    let mut body = String::new();
    for (name, value) in state.counters.snapshot() {
        body.push_str(&format!("# TYPE {name} counter\n{name} {value}\n"));
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        body,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct TicketQuery {
    #[serde(default)]
    spaces: Option<String>,
}

/// Mint a connection ticket for the authenticated caller.
///
/// The caller is authenticated by the same verifier the reads use, so there is
/// one way to be authenticated at this edge and not two. The spaces the ticket
/// names are the spaces its socket may subscribe to.
async fn get_connection_ticket(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    Query(query): Query<TicketQuery>,
) -> Response {
    let nsid = match space_xrpc::ids::Nsid::try_from("space.roomy.auth.getConnectionTicket") {
        Ok(nsid) => nsid,
        Err(error) => return error.into_response(),
    };
    let caller = match state.reads.verifier.verify(&headers, &nsid).await {
        Ok(caller) => caller,
        Err(error) => return error.into_response(),
    };
    let Some(did) = caller.did else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "AuthRequired", "message": "no caller" })),
        )
            .into_response();
    };
    let spaces: Vec<String> = query
        .spaces
        .map(|spaces| {
            spaces
                .split(',')
                .map(str::trim)
                .filter(|space| !space.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    match state.tickets.issue(did.as_str(), spaces.clone()) {
        Ok(ticket) => {
            state
                .counters
                .tickets_issued
                .fetch_add(1, Ordering::Relaxed);
            Json(json!({ "ticket": ticket, "spaces": spaces })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "TicketError", "message": error.to_string() })),
        )
            .into_response(),
    }
}
