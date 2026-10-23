//! Homeserver capability probe.
//!
//! An appservice can only decrypt room events if the homeserver delivers the
//! pieces encryption needs: to-device messages (MSC2409), device lists and
//! one-time-key counts in `/transactions` (MSC3202), and appservice-side device
//! creation (MSC4190). Homeserver support varies, and "does it work" is a
//! measurement rather than a claim, so every check here is a call the bridge
//! would make anyway.
//!
//! Two facts shape the probes:
//!
//! * **MSC3202 and MSC2409 were unstable for a long time.** Synapse emits them
//!   under `org.matrix.msc3202.*` and `de.sorunome.msc2409.to_device`, while a
//!   stabilised homeserver would use the bare names. Both spellings are checked,
//!   because a bridge that only looked for one would report a working homeserver
//!   as broken.
//! * **`/versions` is not the signal.** Synapse does not advertise either MSC
//!   there; it enables them per registration. So the authoritative evidence is
//!   the transaction body the homeserver actually pushes and the device call it
//!   actually answers.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The `to_device` field names a homeserver may use.
pub const TO_DEVICE_KEYS: &[&str] = &["to_device", "de.sorunome.msc2409.to_device"];

/// The MSC3202 transaction extension field names a homeserver may use.
pub const MSC3202_KEYS: &[&str] = &[
    "device_lists",
    "org.matrix.msc3202.device_lists",
    "device_one_time_keys_count",
    "org.matrix.msc3202.device_one_time_keys_count",
    "device_unused_fallback_key_types",
    "org.matrix.msc3202.device_unused_fallback_key_types",
];

/// Whether one MSC is implemented, and how the probe found out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum MscStatus {
    /// The homeserver demonstrated the feature.
    Pass { evidence: String },
    /// The homeserver does not have the feature.
    Fail { evidence: String },
}

impl MscStatus {
    pub fn passed(&self) -> bool {
        matches!(self, MscStatus::Pass { .. })
    }

    /// The observation behind the verdict, for the health report.
    pub fn evidence(&self) -> &str {
        match self {
            MscStatus::Pass { evidence } | MscStatus::Fail { evidence } => evidence,
        }
    }
}

/// The three capabilities E2EE needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HomeserverCapabilities {
    /// MSC4190: the appservice may create and manage devices.
    pub msc4190_devices: MscStatus,
    /// MSC3202: `/transactions` carries device lists and one-time-key counts.
    pub msc3202_transactions: MscStatus,
    /// MSC2409: `/transactions` carries the `to_device` stream.
    pub msc2409_to_device: MscStatus,
    /// What the homeserver reported at `/versions`, for the report.
    pub server_version: Option<String>,
}

impl HomeserverCapabilities {
    /// Every feature E2EE depends on.
    pub fn e2ee_available(&self) -> bool {
        self.msc4190_devices.passed()
            && self.msc3202_transactions.passed()
            && self.msc2409_to_device.passed()
    }

    /// The features that failed, named for an operator.
    pub fn missing(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if !self.msc4190_devices.passed() {
            missing.push("msc4190-devices");
        }
        if !self.msc3202_transactions.passed() {
            missing.push("msc3202-transactions");
        }
        if !self.msc2409_to_device.passed() {
            missing.push("msc2409-to-device");
        }
        missing
    }

    /// A one-line-per-feature report, as `--check-homeserver` prints it.
    pub fn report(&self) -> String {
        let mut out = String::new();
        if let Some(version) = &self.server_version {
            out.push_str(&format!("homeserver: {version}\n"));
        }
        for (name, status) in [
            ("msc4190-devices", &self.msc4190_devices),
            ("msc3202-transactions", &self.msc3202_transactions),
            ("msc2409-to-device", &self.msc2409_to_device),
        ] {
            let verdict = if status.passed() { "pass" } else { "fail" };
            out.push_str(&format!("{name}: {verdict} ({})\n", status.evidence()));
        }
        out.push_str(&format!(
            "e2ee: {}\n",
            if self.e2ee_available() {
                "available"
            } else {
                "unavailable"
            }
        ));
        out
    }
}

/// What a transaction the homeserver pushed actually contained.
///
/// Kept as the top-level key set plus the `to_device` count, because that is
/// exactly the evidence MSC3202 and MSC2409 need and nothing else is required.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservedTransaction {
    /// Every top-level key the transaction body carried.
    pub keys: Vec<String>,
    /// How many to-device messages it carried.
    pub to_device_count: usize,
}

impl ObservedTransaction {
    /// Read a transaction body.
    pub fn from_body(body: &serde_json::Value) -> Self {
        let keys = body
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        let to_device_count = TO_DEVICE_KEYS
            .iter()
            .filter_map(|key| body.get(*key).and_then(|value| value.as_array()))
            .map(|messages| messages.len())
            .sum();
        Self {
            keys,
            to_device_count,
        }
    }

    /// Whether any key matching `candidates` is present.
    fn has_any(&self, candidates: &[&str]) -> Option<String> {
        candidates
            .iter()
            .find(|candidate| self.keys.iter().any(|key| key == *candidate))
            .map(|key| (*key).to_string())
    }

    /// Fold a later transaction's evidence into this one.
    ///
    /// Keys are unioned and to-device counts summed, because a capability shown
    /// by any single transaction is a capability the homeserver has. Evidence
    /// only ever accumulates: a homeserver that stops sending a field has still
    /// been measured as supporting it.
    pub fn merge(&mut self, later: Self) {
        for key in later.keys {
            if !self.keys.contains(&key) {
                self.keys.push(key);
            }
        }
        self.to_device_count += later.to_device_count;
    }

    /// Whether any observed transaction carried a to-device stream.
    pub fn has_to_device(&self) -> bool {
        self.has_any(TO_DEVICE_KEYS).is_some()
    }

    /// Whether any observed transaction carried the MSC3202 extensions.
    pub fn has_msc3202(&self) -> bool {
        self.has_any(MSC3202_KEYS).is_some()
    }
}

/// The probe's shared state: what this homeserver has actually sent across
/// every transaction the appservice received.
///
/// Shared between the HTTP server (which sees every transaction) and the probe
/// (which reads them), so `/capabilities` reports what this homeserver actually
/// sent rather than what it claims to support.
///
/// Transactions are accumulated rather than replaced. A homeserver batches on a
/// timer, so the state events for a room and the to-device message that follows
/// them arrive in different transactions; keeping only the last one would
/// discard the evidence MSC3202 needs and report a working homeserver as broken.
#[derive(Debug, Clone, Default)]
pub struct TransactionObserver {
    observed: Arc<Mutex<Option<ObservedTransaction>>>,
}

impl TransactionObserver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a transaction the server received, merging it into what earlier
    /// transactions showed.
    pub fn observe(&self, body: &serde_json::Value) {
        let observed = ObservedTransaction::from_body(body);
        let mut slot = self.observed.lock();
        match slot.as_mut() {
            Some(accumulated) => accumulated.merge(observed),
            None => *slot = Some(observed),
        }
    }

    /// Everything observed so far, if any traffic has arrived.
    pub fn last(&self) -> Option<ObservedTransaction> {
        self.observed.lock().clone()
    }
}

/// Runs the probe against a live homeserver.
pub struct CapabilityProbe {
    http: reqwest::Client,
    base_url: String,
    as_token: crate::appservice::AsToken,
    /// The appservice's own user, whose device the MSC4190 check creates.
    sender_localpart: String,
    domain: String,
    observer: TransactionObserver,
}

impl CapabilityProbe {
    pub fn new(
        base_url: impl Into<String>,
        as_token: crate::appservice::AsToken,
        sender_localpart: impl Into<String>,
        domain: impl Into<String>,
        observer: TransactionObserver,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            as_token,
            sender_localpart: sender_localpart.into(),
            domain: domain.into(),
            observer,
        }
    }

    /// Measure the homeserver.
    pub async fn run(&self) -> HomeserverCapabilities {
        let server_version = self.versions().await;
        let msc4190_devices = self.probe_device_management().await;
        let msc3202_transactions = self.probe_transaction_extensions();
        let msc2409_to_device = self.probe_to_device();

        HomeserverCapabilities {
            msc4190_devices,
            msc3202_transactions,
            msc2409_to_device,
            server_version,
        }
    }

    async fn versions(&self) -> Option<String> {
        let url = format!("{}/_matrix/client/versions", self.base_url);
        let response = self.http.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: serde_json::Value = response.json().await.ok()?;
        body.get("server_version")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    }

    /// MSC4190 is decided by creating a device as the appservice's own user.
    ///
    /// The appservice owns its sender localpart, so this is exactly the call the
    /// bridge makes to install a ghost device — and the only one that separates
    /// "implements MSC4190" from "advertises it".
    async fn probe_device_management(&self) -> MscStatus {
        let user_id = format!("@{}:{}", self.sender_localpart, self.domain);
        let device_id = format!("ROOMYPROBE{}", ulid::Ulid::generate());
        let url = format!(
            "{}/_matrix/client/v3/devices/{}?user_id={}",
            self.base_url, device_id, user_id
        );

        let response = self
            .http
            .put(&url)
            .bearer_auth(&self.as_token)
            .json(&serde_json::json!({ "display_name": "roomy bridge capability probe" }))
            .send()
            .await;

        let status = match response {
            Ok(response) => response.status(),
            Err(error) => {
                return MscStatus::Fail {
                    evidence: format!("PUT /devices could not be reached: {error}"),
                }
            }
        };

        if !status.is_success() {
            return MscStatus::Fail {
                evidence: format!(
                    "PUT /devices answered HTTP {status} — an appservice without MSC4190 \
                     cannot create devices"
                ),
            };
        }

        // Remove the probe device so repeated runs do not accumulate them.
        let delete_url = format!(
            "{}/_matrix/client/v3/devices/{}?user_id={}",
            self.base_url, device_id, user_id
        );
        let _ = self
            .http
            .delete(&delete_url)
            .bearer_auth(&self.as_token)
            .send()
            .await;

        MscStatus::Pass {
            evidence: format!("PUT /devices answered HTTP {status} and the device was created"),
        }
    }

    /// MSC3202 is decided by the keys the homeserver actually puts on a
    /// transaction.
    fn probe_transaction_extensions(&self) -> MscStatus {
        match self.observer.last() {
            Some(transaction) => match transaction.has_any(MSC3202_KEYS) {
                Some(key) => MscStatus::Pass {
                    evidence: format!("transactions carried {key}"),
                },
                None => MscStatus::Fail {
                    evidence: format!(
                        "transactions carried only [{}] — no device-list or one-time-key fields",
                        transaction.keys.join(", ")
                    ),
                },
            },
            None => MscStatus::Fail {
                evidence: "no transaction has been delivered yet, so the extension fields \
                           could not be observed"
                    .to_string(),
            },
        }
    }

    /// MSC2409 is decided by the `to_device` field on a transaction.
    fn probe_to_device(&self) -> MscStatus {
        match self.observer.last() {
            Some(transaction) => match transaction.has_any(TO_DEVICE_KEYS) {
                Some(key) => MscStatus::Pass {
                    evidence: format!(
                        "transactions carried {key} with {} message(s)",
                        transaction.to_device_count
                    ),
                },
                None => MscStatus::Fail {
                    evidence: format!(
                        "transactions carried only [{}] — no to-device stream",
                        transaction.keys.join(", ")
                    ),
                },
            },
            None => MscStatus::Fail {
                evidence: "no transaction has been delivered yet, so the to-device stream \
                           could not be observed"
                    .to_string(),
            },
        }
    }
}

/// The MSC3202 extension fields, for the server's transaction parser.
pub fn transaction_extension_keys(body: &serde_json::Value) -> Vec<String> {
    MSC3202_KEYS
        .iter()
        .filter(|key| body.get(**key).is_some())
        .map(|key| (*key).to_string())
        .collect()
}

/// The to-device messages a transaction carries, under either field name.
pub fn transaction_to_device(body: &serde_json::Value) -> Vec<serde_json::Value> {
    TO_DEVICE_KEYS
        .iter()
        .filter_map(|key| body.get(*key).and_then(|value| value.as_array()))
        .flatten()
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all_pass() -> HomeserverCapabilities {
        HomeserverCapabilities {
            msc4190_devices: MscStatus::Pass {
                evidence: "PUT /devices answered HTTP 201".into(),
            },
            msc3202_transactions: MscStatus::Pass {
                evidence: "transactions carried org.matrix.msc3202.device_lists".into(),
            },
            msc2409_to_device: MscStatus::Pass {
                evidence: "transactions carried de.sorunome.msc2409.to_device with 1 message(s)"
                    .into(),
            },
            server_version: Some("Synapse/1.99".into()),
        }
    }

    #[test]
    fn e2ee_needs_all_three() {
        assert!(all_pass().e2ee_available());

        let mut capabilities = all_pass();
        capabilities.msc2409_to_device = MscStatus::Fail {
            evidence: "not observed".into(),
        };
        assert!(!capabilities.e2ee_available());
        assert_eq!(capabilities.missing(), vec!["msc2409-to-device"]);
    }

    #[test]
    fn the_report_names_every_feature_and_its_verdict() {
        let mut capabilities = all_pass();
        capabilities.msc3202_transactions = MscStatus::Fail {
            evidence: "transactions carried only [events]".into(),
        };
        let report = capabilities.report();
        assert!(report.contains("msc4190-devices: pass"));
        assert!(report.contains("msc3202-transactions: fail (transactions carried only [events])"));
        assert!(report.contains("msc2409-to-device: pass"));
        assert!(report.contains("e2ee: unavailable"));
    }

    #[test]
    fn an_unobserved_transaction_fails_rather_than_defaulting_to_pass() {
        let capabilities = HomeserverCapabilities {
            msc4190_devices: MscStatus::Pass {
                evidence: "x".into(),
            },
            msc3202_transactions: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            msc2409_to_device: MscStatus::Fail {
                evidence: "no transaction".into(),
            },
            server_version: None,
        };
        assert!(!capabilities.e2ee_available());
    }

    #[test]
    fn the_unstable_synapse_keys_are_recognised() {
        let body = json!({
            "events": [],
            "ephemeral": [],
            "de.sorunome.msc2409.to_device": [{ "type": "m.room.encrypted" }],
            "org.matrix.msc3202.device_lists": { "changed": [], "left": [] },
            "org.matrix.msc3202.device_one_time_keys_count": {},
        });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 1);
        assert!(transaction.has_any(TO_DEVICE_KEYS).is_some());
        assert!(transaction.has_any(MSC3202_KEYS).is_some());
        assert_eq!(
            transaction_extension_keys(&body),
            vec![
                "org.matrix.msc3202.device_lists",
                "org.matrix.msc3202.device_one_time_keys_count"
            ]
        );
        assert_eq!(transaction_to_device(&body).len(), 1);
    }

    #[test]
    fn the_stable_keys_are_recognised_too() {
        let body = json!({
            "events": [],
            "to_device": [{ "type": "m.room.encrypted" }, { "type": "m.room_key" }],
            "device_lists": { "changed": [], "left": [] },
        });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 2);
        assert_eq!(
            transaction.has_any(TO_DEVICE_KEYS).as_deref(),
            Some("to_device")
        );
        assert_eq!(
            transaction.has_any(MSC3202_KEYS).as_deref(),
            Some("device_lists")
        );
    }

    #[test]
    fn a_homeserver_with_only_events_fails_both_stream_checks() {
        // What continuwuity sends: PDUs and nothing else.
        let body = json!({ "events": [{ "type": "m.room.message" }] });
        let transaction = ObservedTransaction::from_body(&body);
        assert_eq!(transaction.to_device_count, 0);
        assert!(transaction.has_any(TO_DEVICE_KEYS).is_none());
        assert!(transaction.has_any(MSC3202_KEYS).is_none());
    }

    #[test]
    fn the_observer_keeps_the_last_transaction() {
        let observer = TransactionObserver::new();
        assert!(observer.last().is_none());
        observer.observe(&json!({ "events": [], "to_device": [] }));
        assert!(observer.last().is_some());
        assert_eq!(observer.last().unwrap().to_device_count, 0);
    }
}
