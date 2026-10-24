//! Per-space XRPC read serving for the Roomy space worker.
//!
//! One process serves many spaces: [`registry::SpaceResolver`] turns a request's
//! `spaceId` — or the room or message it names — into the database that answers
//! it, and keeps a bounded set of them open. The crate never owns read state:
//! the caller's watermarks arrive on `x-roomy-read-positions`, and the unread
//! counts the four board/room endpoints need are derived from them against the
//! local `entities` table.
//!
//! ```no_run
//! use std::sync::Arc;
//! use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
//! use space_xrpc::state::XrpcState;
//! use space_xrpc::verify::TestMode;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let spaces = SpaceRegistry::new("data/spaces", Some("data/global.sqlite".into()), 256);
//! let first = spaces.resolve_space("did:web:example").ok_or("no such space")?;
//! let state = XrpcState::new(first, Arc::new(TestMode))
//!     .with_spaces(Arc::new(spaces) as Arc<dyn SpaceResolver>);
//! let app = space_xrpc::router(state);
//! let listener = tokio::net::TcpListener::bind("127.0.0.1:8090").await?;
//! axum::serve(listener, app).await?;
//! # Ok(())
//! # }
//! ```

pub mod access;
pub mod dto;
pub mod error;
pub mod handlers;
pub mod ids;
pub mod params;
pub mod queries;
pub mod read_positions;
pub mod registry;
pub mod state;
pub mod store;
pub mod time;
pub mod verify;

use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::XrpcError;
use crate::handlers::common::context;
use crate::ids::Nsid;
use crate::params::Params;
use crate::state::{SpaceReadDb, XrpcState};

/// The space database this request is answered from.
///
/// `spaceId` names a space directly. The other per-space NSIDs name a room, a
/// message or a thread, and resolve through the registry's entity→space index.
fn resolve_space(
    state: &XrpcState,
    params: &Params,
    nsid: &Nsid,
) -> Result<std::sync::Arc<SpaceReadDb>, XrpcError> {
    // Which id a request names is the endpoint's contract, so the missing-param
    // error names that id the way the handler's own validation would.
    let entity_key = match nsid.as_str() {
        "space.roomy.space.getMetadata" | "space.roomy.space.getThreads" => "spaceId",
        "space.roomy.room.getMetadata"
        | "space.roomy.room.getMessages"
        | "space.roomy.room.getThreads"
        | "space.roomy.room.getLinks" => "roomId",
        _ => "messageId",
    };
    if let Some(space_id) = params.optional_string("spaceId") {
        return state
            .spaces
            .resolve_space(&space_id)
            .ok_or_else(|| XrpcError::not_found(format!("Space not found: {space_id}")));
    }
    // The gateway resolves a space by any of these; a request that names none of
    // them is the endpoint's own missing-parameter error. An id nothing resolves
    // is the endpoint's not-found, named for the entity it asked about.
    if let Some(entity_id) = params.optional_string(entity_key) {
        let what = match entity_key {
            "roomId" => "Room",
            _ => "Message",
        };
        return state
            .spaces
            .resolve_entity(&entity_id)
            .ok_or_else(|| XrpcError::not_found(format!("{what} not found: {entity_id}")));
    }
    Err(XrpcError::invalid_request(format!(
        "{} params validation failed: {entity_key} must be a string (was missing)",
        nsid.as_str()
    )))
}

/// NSIDs served by the worker. The gateway routes exactly these; anything else
/// is the gateway's business.
pub const ENDPOINTS: &[&str] = &[
    "space.roomy.space.getMetadata",
    "space.roomy.space.getThreads",
    "space.roomy.room.getMetadata",
    "space.roomy.room.getMessages",
    "space.roomy.room.getThreads",
    "space.roomy.room.getLinks",
    "space.roomy.message.getMessage",
    "space.roomy.message.getReactions",
];

pub fn router(state: XrpcState) -> Router {
    Router::new()
        .route("/xrpc/{nsid}", get(dispatch))
        .with_state(state)
}

async fn dispatch(
    State(state): State<XrpcState>,
    Path(nsid): Path<String>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Response, XrpcError> {
    let nsid = Nsid::try_from(nsid.as_str())?;
    let params = Params::parse(query.as_deref());
    let ctx = context(&state, &headers, &nsid).await?;
    // One process serves many spaces: the request names its space, or names an
    // entity the gateway's index resolves to one.
    let state = state.for_space(resolve_space(&state, &params, &nsid)?);

    match nsid.as_str() {
        "space.roomy.space.getMetadata" => {
            Ok(Json(handlers::space::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getThreads" => {
            Ok(Json(handlers::space::get_threads(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getMetadata" => {
            Ok(Json(handlers::room::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getMessages" => {
            Ok(Json(handlers::room::get_messages(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getThreads" => {
            Ok(Json(handlers::room::get_threads(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getLinks" => {
            Ok(Json(handlers::room::get_links(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.message.getMessage" => {
            Ok(Json(handlers::message::get_message(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.message.getReactions" => {
            Ok(Json(handlers::message::get_reactions(&state, &params, &ctx)?).into_response())
        }
        _ => Err(XrpcError::not_found(format!(
            "Unknown NSID: {}",
            nsid.as_str()
        ))),
    }
}
