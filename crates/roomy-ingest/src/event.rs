//! The wire form of one event in a `sendEvents` batch.
//!
//! An event is a JSON object whose `$type` names the record it describes and
//! whose `id` is the ULID the sender minted. Everything below the envelope is
//! the type's own payload, which the record adapter reads; the ingress itself
//! only needs the envelope, plus the payload for authorization.
//!
//! Parsing here is deliberately shallow — envelope only. A payload that the
//! adapter cannot describe contributes no change rather than failing the
//! append, so validating payload shape twice would only produce a second answer
//! to the same question.

use serde_json::Value;

use crate::ids::{is_ulid, nsid_of};

/// One event, decoded far enough that the ingress can decide about it.
#[derive(Debug, Clone)]
pub struct WireEvent {
    /// The event exactly as it arrived.
    pub raw: Value,
    /// Its `$type`.
    pub nsid: String,
    /// Its id: the ULID the sender minted, which is also the message id for a
    /// `createMessage` and the room id for a `createRoom`.
    pub id: String,
    /// The room it names, when it names one. Absent for space-level events.
    pub room: Option<String>,
}

impl WireEvent {
    /// Decode the envelope. The `Err` is the message a 400 carries.
    pub fn parse(value: &Value) -> Result<Self, String> {
        let Some(object) = value.as_object() else {
            return Err("event is not an object".to_string());
        };
        let Some(nsid) = nsid_of(object.get("$type")) else {
            return Err("invalid $type: must be a string".to_string());
        };
        let Some(id) = object.get("id").and_then(Value::as_str) else {
            return Err("invalid id: must be a string".to_string());
        };
        if !is_ulid(id) {
            return Err("invalid id: must be a ULID".to_string());
        }
        let room = match object.get("room") {
            None | Some(Value::Null) => None,
            Some(Value::String(room)) if is_ulid(room) => Some(room.clone()),
            Some(_) => return Err("invalid room: must be a ULID".to_string()),
        };
        Ok(Self {
            raw: value.clone(),
            nsid,
            id: id.to_string(),
            room,
        })
    }

    /// The payload field `name`, when it is a string.
    pub fn string(&self, name: &str) -> Option<&str> {
        self.raw.get(name).and_then(Value::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "01JC0000000000000000000C01";

    #[test]
    fn decodes_the_envelope() {
        let event = json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": ID,
            "room": "01JC0000000000000000000R01",
            "content": { "mimeType": "text/markdown", "data": { "$bytes": "aGk=" } }
        });
        let parsed = WireEvent::parse(&event).unwrap();
        assert_eq!(parsed.nsid, "space.roomy.message.createMessage.v0");
        assert_eq!(parsed.id, ID);
        assert_eq!(parsed.room.as_deref(), Some("01JC0000000000000000000R01"));
    }

    #[test]
    fn a_space_level_event_has_no_room() {
        let parsed = WireEvent::parse(&json!({
            "$type": "space.roomy.space.updateSpace.v0",
            "id": ID
        }))
        .unwrap();
        assert!(parsed.room.is_none());
    }

    #[test]
    fn a_missing_type_names_the_field() {
        let error = WireEvent::parse(&json!({ "id": ID })).unwrap_err();
        assert_eq!(error, "invalid $type: must be a string");
    }

    #[test]
    fn a_non_ulid_id_is_refused() {
        let error = WireEvent::parse(&json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": "not-a-ulid"
        }))
        .unwrap_err();
        assert_eq!(error, "invalid id: must be a ULID");
    }

    #[test]
    fn a_non_object_is_refused() {
        assert!(WireEvent::parse(&json!([1, 2])).is_err());
    }
}
