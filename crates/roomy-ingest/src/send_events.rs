//! `space.roomy.space.sendEvents`: validate, authorize, append.
//!
//! The order matters and is the same as the appserver's:
//!
//!  1. the body names a space and carries between one and fifty events;
//!  2. the caller is authenticated, and is not banned from the space;
//!  3. every event decodes and passes its own write authorization, in batch
//!     order, so the first bad event decides the error the client sees;
//!  4. the batch is appended in one transaction.
//!
//! A caller who is not a member may still be authorized: a federated channel
//! grants write access to another space's members, so authorization is per
//! event and not a space-level gate. The ban check happens first because a ban
//! is a space-level refusal to participate at all.

use std::sync::Arc;

use serde_json::Value;
use space_xrpc::access::space_access;
use space_xrpc::state::SpaceReadDb;
use space_xrpc::store::GlobalStores;

use crate::append::{AppendEntry, EventLog};
use crate::event::WireEvent;
use crate::record_change::{feed_rows, EntryFacts};
use crate::write_auth::{check_write_auth, WriteAuth, WriteDenial};

/// The most events one batch may carry.
pub const MAX_BATCH_SIZE: usize = 50;

/// The body of a `sendEvents` call.
#[derive(Debug, Clone)]
pub struct SendEventsBody {
    pub space_id: String,
    pub events: Vec<Value>,
}

impl SendEventsBody {
    /// Decode the JSON body, with the appserver's own validation messages.
    pub fn parse(body: &[u8]) -> Result<Self, WriteDenial> {
        let value: Value = serde_json::from_slice(body)
            .map_err(|_| WriteDenial::invalid_request("Request body is not valid JSON"))?;
        let Some(space_id) = value.get("spaceId").and_then(Value::as_str) else {
            return Err(WriteDenial::invalid_request(
                "Missing or empty required field: spaceId",
            ));
        };
        if space_id.is_empty() {
            return Err(WriteDenial::invalid_request(
                "Missing or empty required field: spaceId",
            ));
        }
        let Some(events) = value.get("events").and_then(Value::as_array) else {
            return Err(WriteDenial::invalid_request(
                "Missing or empty required field: events",
            ));
        };
        if events.is_empty() {
            return Err(WriteDenial::invalid_request(
                "Missing or empty required field: events",
            ));
        }
        if events.len() > MAX_BATCH_SIZE {
            return Err(WriteDenial::invalid_request(format!(
                "Too many events: max {MAX_BATCH_SIZE}"
            )));
        }
        Ok(Self {
            space_id: space_id.to_string(),
            events: events.clone(),
        })
    }
}

/// What the append produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendEventsOutcome {
    /// The index the batch's first entry landed on.
    pub start_idx: i64,
    pub appended: usize,
}

/// Where a batch's authorization reads its facts from.
pub struct IngestState {
    /// The target space's database, for the caller's access and each event's
    /// room.
    pub space: Arc<SpaceReadDb>,
    /// The gateway's registry replica, for federation grants.
    pub stores: Arc<dyn GlobalStores>,
    /// The service's own DID: the authority that evaluates bans, exempt from
    /// them for the narrow set of types it is allowed to author.
    pub service_did: Option<String>,
}

/// Validate, authorize and append one batch.
///
/// `now_ms` is the instant the batch was accepted. It is a parameter rather
/// than a clock read so the ordering key is a function of its inputs.
pub fn send_events(
    log: &mut EventLog,
    state: &IngestState,
    caller_did: &str,
    body: &SendEventsBody,
    now_ms: i64,
) -> Result<SendEventsOutcome, WriteDenial> {
    let access = state
        .space
        .with(|conn| Ok(space_access(conn, &body.space_id, Some(caller_did))?))
        .map_err(WriteDenial::from)?;
    let exempt = state.service_did.as_deref() == Some(caller_did);
    if access.is_banned && !exempt {
        return Err(WriteDenial::forbidden("Caller is banned from this space"));
    }

    // Decode and authorize in batch order: the first event that fails decides
    // the response, exactly as the appserver's loop does.
    let mut events = Vec::with_capacity(body.events.len());
    for (index, raw) in body.events.iter().enumerate() {
        let event = match WireEvent::parse(raw) {
            Ok(event) => event,
            Err(message) => {
                return Err(WriteDenial::invalid_request(format!(
                    "Event at index {index} is invalid: {message}"
                )))
            }
        };
        let auth = WriteAuth {
            space_id: &body.space_id,
            caller_did,
            access,
            service_did: state.service_did.as_deref(),
            stores: state.stores.as_ref(),
        };
        state
            .space
            .with(|conn| {
                check_write_auth(conn, &event, &auth).map_err(|denial| {
                    space_xrpc::error::XrpcError::new(denial.status, denial.error, denial.message)
                })
            })
            .map_err(WriteDenial::from)?;
        events.push(event);
    }

    // From here the batch is authorized: encode, adapt, append. A change the
    // adapter cannot describe contributes nothing, which is the adapter's
    // answer, not a failure of the batch.
    let mut entries = Vec::with_capacity(events.len());
    for event in &events {
        let mut payload = Vec::new();
        ciborium::into_writer(&event.raw, &mut payload).map_err(
            |error: ciborium::ser::Error<std::io::Error>| {
                WriteDenial::internal(format!("event is not encodable: {error}"))
            },
        )?;
        let facts = EntryFacts {
            stream_id: &body.space_id,
            idx: 0,
            actor: caller_did,
            received_at: now_ms,
        };
        let rows = feed_rows(&event.raw, &facts);
        entries.push(AppendEntry {
            stream_id: body.space_id.clone(),
            user: caller_did.to_string(),
            payload,
            event_type: event.nsid.clone(),
            created_at: now_ms,
            received_at: now_ms,
            rows,
        });
    }
    let appended = entries.len();
    let start_idx = log
        .append(&entries)
        .map_err(|error| WriteDenial::internal(error.to_string()))?;
    Ok(SendEventsOutcome {
        start_idx,
        appended,
    })
}
