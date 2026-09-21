#
# Behavioral tests for Roomy's shared arbiter policy (`roomy-default.rego`),
# run with the arbiter CLI:
#
#   cargo run -p arbiter-cli -- policy test policies/roomy
#
# The CLI compiles the policy exactly as an `installPolicy` does
# (`validate_policy`), then drives the production request machine
# (`ArbiterReqMachine`) for every case below, answering each `xrpc` host call
# by evaluating the `mock` partial object with the request the policy issued,
# and picking the running case's entry. A case passes when the sequence of
# remote requests and the final machine outcome match its `expect` block.
#
# Every case registers itself: a `cases["<case name>"] := { ... }` rule (a
# partial-object rule — the definition is the registration, there is no
# central registry). The case name is the only linkage between a case and its
# `mock["<case name>"]` arms.
#
# Case shape (the object under `cases["<case name>"]`):
#
#   request      — the caller's XRPC request: { method, nsid, parameters?,
#                  body?, encoding? } (null/absent = none)
#   ctx          — the per-request context the server injects: { arbiterDid,
#                  pdsService, callerDid, target }
#   extraLayers  — optional extra pipeline layer sources (community layers
#                  installed after the Roomy layer)
#   expect.calls  — the exact sequence of remote requests the policy must
#                  issue, as request subset-matchers ({ target, method, nsid,
#                  parameters, body, encoding }; omitted fields unchecked)
#   expect.result — the final machine outcome: {"handleBuiltin": true} or an
#                  ok/err envelope ({ ok, output } / { ok: false, error })
#
# Mock arms are evaluated per `xrpc` host call with `input.request` set to the
# request the policy issued ({ target, method, nsid, parameters, body, encoding })
# and `input.case` set to the running case, and return the envelope to feed
# back. A request no arm matches fails the case loudly — a policy bug must
# fail the test, not silently deny. A case that must issue no calls needs no
# mock arms at all: an unexpected call fails with "no mock arm matched".
#
package roomy_policy_test

import rego.v1

# ---------------------------------------------------------------- fixtures --

space := "did:plc:space.test"
appserver := "did:web:api.roomy.space"
alice := "did:plc:alice"
mallory := "did:plc:mallory"

steward_pds := concat("#", [space, "atproto_pds"])
declared_target := concat("#", [space, "arbiter_xrpc"])
appserver_endpoint := concat("#", [appserver, "space_roomy_appserver"])

# The request context the server builds for a caller acting on the space's
# arbiter.
ctx(caller) := {
	"arbiterDid": space,
	"pdsService": steward_pds,
	"callerDid": caller,
	"target": declared_target,
}

# Canned xrpc envelopes a mock arm can serve (the same ok/err shape the
# machine feeds back to the policy in production).
record(did) := {"ok": true, "output": {"value": {"did": did}}}

access(admin) := {"ok": true, "output": {"isAdmin": admin, "roleIds": []}}

xrpc_err(status, error, message) := {
	"ok": false,
	"error": {"status": status, "error": error, "message": message},
}

record_not_found := xrpc_err(404, "RecordNotFound", "record not found")

# A getRecord body whose `did` is not a string.
non_string_did := {"ok": true, "output": {"value": {"did": 42}}}

# The pipeline's default 403 deny, returned when the Roomy layer passes (or
# no later layer handles).
default_deny := {
	"ok": false,
	"error": {
		"status": 403,
		"error": "Denied",
		"message": "request denied by the arbiter policy pipeline",
	},
}

# A community layer installed after the Roomy layer: it handles whatever the
# Roomy layer passes to it.
community_layer := `package arbiter

result := {"ok": true, "output": {"handledBy": "layer2"}}
`

# --------------------------------------------------- shared mock machinery --

# Classify the request the policy issued, so mock arms can pick a canned
# response. The two getRecord reads are distinguished by the `collection`
# parameter; the AppView check by its NSID.
is_recovery_lookup(req) if {
	req.nsid == "com.atproto.repo.getRecord"
	req.parameters.collection == "town.muni.arbiter.recovery"
}

is_service_lookup(req) if {
	req.nsid == "com.atproto.repo.getRecord"
	req.parameters.collection == "space.roomy.service"
}

is_access_lookup(req) if req.nsid == "space.roomy.space.getUserAccess"

# Anything else the policy issues is the proxy passthrough.
is_proxy_call(req) if {
	not is_recovery_lookup(req)
	not is_service_lookup(req)
	not is_access_lookup(req)
}

# The proxy passthrough response: echo the issued request back, so cases can
# assert that method/nsid/parameters/body/encoding are forwarded verbatim.
echo := {
	"ok": true,
	"output": {
		"mockProxied": true,
		"nsid": input.request.nsid,
		"method": input.request.method,
		"params": input.request.parameters,
		"body": input.request.body,
		"encoding": input.request.encoding,
	},
}

# ---------------------------------------------------------- call matchers ---

# A getRecord lookup against the steward's PDS (the recovery and service
# reads both have this shape).
record_call(collection) := {
	"target": steward_pds,
	"method": "GET",
	"nsid": "com.atproto.repo.getRecord",
	"parameters": {"repo": space, "collection": collection, "rkey": "self"},
}

# The AppView access check must be addressed to the appserver named by the
# service record, as a GET, asking about THIS caller in THIS space.
access_call(caller) := {
	"target": appserver_endpoint,
	"method": "GET",
	"nsid": "space.roomy.space.getUserAccess",
	"parameters": {"spaceId": space, "userDid": caller},
}

# The proxy passthrough re-issues the caller's request verbatim to the
# caller's declared destination (ctx.target — deliberately distinct
# from the steward's PDS, so a policy that conflates the two fails here).
proxy_call(method, nsid, parameters) := {
	"target": declared_target,
	"method": method,
	"nsid": nsid,
	"parameters": parameters,
}

# ------------------------------------ admin_plain_request_is_proxied --------
#
# A Roomy admin's plain request is forwarded to the caller's declared
# destination as the space, after the recovery lookup misses and the AppView
# says admin.
cases["admin_plain_request_is_proxied"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {"space": space},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(alice),
			proxy_call("GET", "space.roomy.space.getMetadata", {"space": space}),
		],
		"result": {
			"ok": true,
			"output": {
				"mockProxied": true,
				"nsid": "space.roomy.space.getMetadata",
				"method": "GET",
				"params": {"space": space},
				"encoding": null,
			},
		},
	},
}

mock["admin_plain_request_is_proxied"] := record_not_found if
	is_recovery_lookup(input.request)

mock["admin_plain_request_is_proxied"] := record(appserver) if
	is_service_lookup(input.request)

mock["admin_plain_request_is_proxied"] := access(true) if
	is_access_lookup(input.request)

mock["admin_plain_request_is_proxied"] := echo if is_proxy_call(input.request)

# -------------------------- admin_management_request_hands_to_builtin -------
#
# A Roomy admin's management request is handed to the arbiter's built-in
# handler, with adminship established through the full lookup chain.

cases["admin_management_request_hands_to_builtin"] := {
	"request": {
		"method": "GET",
		"nsid": "town.muni.arbiter.installPolicy",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(alice),
		],
		"result": {"handleBuiltin": true},
	},
}

mock["admin_management_request_hands_to_builtin"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["admin_management_request_hands_to_builtin"] := record(appserver) if
	is_service_lookup(input.request)

mock["admin_management_request_hands_to_builtin"] := access(true) if
	is_access_lookup(input.request)

mock["admin_management_request_hands_to_builtin"] := echo if
	is_proxy_call(input.request)

# ------------------------------------------------- non_admin_is_denied ------
#
# A non-admin is denied with the explicit 403 envelope after all three
# lookups.

cases["non_admin_is_denied"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(mallory),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(mallory),
		],
		"result": default_deny,
	},
}

mock["non_admin_is_denied"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["non_admin_is_denied"] := record(appserver) if
	is_service_lookup(input.request)

mock["non_admin_is_denied"] := access(false) if is_access_lookup(input.request)

mock["non_admin_is_denied"] := echo if is_proxy_call(input.request)

# --------------------- space_itself_is_allowed_without_any_lookup -----------
#
# The space account itself is allowed with zero lookups — only the proxy
# call to its declared destination.
cases["space_itself_is_allowed_without_any_lookup"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(space),
	"expect": {
		"calls": [
			proxy_call("GET", "space.roomy.space.getMetadata", {}),
		],
		"result": {
			"ok": true,
			"output": {
				"mockProxied": true,
				"nsid": "space.roomy.space.getMetadata",
				"method": "GET",
			},
		},
	},
}

mock["space_itself_is_allowed_without_any_lookup"] := echo if
	is_proxy_call(input.request)

# -------------------- space_itself_management_hands_to_builtin --------------
#
# The space account's management requests hand off to the builtin with no
# lookups and no proxy: the mock is never consulted (an unexpected call fails
# with "no mock arm matched").

cases["space_itself_management_hands_to_builtin"] := {
	"request": {
		"method": "GET",
		"nsid": "town.muni.arbiter.resetConfig",
		"parameters": {},
	},
	"ctx": ctx(space),
	"expect": {
		"calls": [],
		"result": {"handleBuiltin": true},
	},
}

# --------------------- recovery_admin_is_allowed_without_appview ------------
#
# The recovery admin (the appserver) is allowed, and the AppView is never
# consulted — the recovery branch matches first.

cases["recovery_admin_is_allowed_without_appview"] := {
	"request": {
		"method": "POST",
		"nsid": "com.atproto.repo.putRecord",
		"body": {"repo": space},
		"encoding": "application/json",
	},
	"ctx": ctx(appserver),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			proxy_call("POST", "com.atproto.repo.putRecord", null),
		],
		"result": {
			"ok": true,
			"output": {
				"mockProxied": true,
				"nsid": "com.atproto.repo.putRecord",
				"method": "POST",
				"body": {"repo": space},
				"encoding": "application/json",
			},
		},
	},
}

mock["recovery_admin_is_allowed_without_appview"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["recovery_admin_is_allowed_without_appview"] := echo if
	is_proxy_call(input.request)

# --------------------- post_body_is_passed_through_to_the_proxy -------------
#
# A POST proxy request (the provisioning putRecord shape) carries its method,
# encoding, and body through to the outgoing proxied request verbatim.

cases["post_body_is_passed_through_to_the_proxy"] := {
	"request": {
		"method": "POST",
		"nsid": "com.atproto.repo.putRecord",
		"body": {
			"repo": space,
			"collection": "space.roomy.service",
			"rkey": "self",
			"record": {"$type": "space.roomy.service", "did": appserver},
		},
		"encoding": "application/json",
	},
	"ctx": ctx(appserver),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			proxy_call("POST", "com.atproto.repo.putRecord", null),
		],
		"result": {
			"ok": true,
			"output": {
				"mockProxied": true,
				"method": "POST",
				"nsid": "com.atproto.repo.putRecord",
				"encoding": "application/json",
				"body": {
					"repo": space,
					"collection": "space.roomy.service",
					"rkey": "self",
					"record": {"$type": "space.roomy.service", "did": appserver},
				},
			},
		},
	},
}

mock["post_body_is_passed_through_to_the_proxy"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["post_body_is_passed_through_to_the_proxy"] := echo if
	is_proxy_call(input.request)

# --------------------- recovery_admin_management_hands_to_builtin -----------
#
# The recovery admin's management requests hand off to the builtin after only
# the recovery lookup.

cases["recovery_admin_management_hands_to_builtin"] := {
	"request": {
		"method": "GET",
		"nsid": "town.muni.arbiter.installPolicy",
		"parameters": {},
	},
	"ctx": ctx(appserver),
	"expect": {
		"calls": [record_call("town.muni.arbiter.recovery")],
		"result": {"handleBuiltin": true},
	},
}

mock["recovery_admin_management_hands_to_builtin"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["recovery_admin_management_hands_to_builtin"] := echo if
	is_proxy_call(input.request)

# --------------------------------------- missing_service_record_denies ------
#
# A missing service record fails closed: the AppView is never consulted and
# the caller is denied, even though the AppView would have said admin.

cases["missing_service_record_denies"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
		],
		"result": default_deny,
	},
}

mock["missing_service_record_denies"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["missing_service_record_denies"] := record_not_found if
	is_service_lookup(input.request)

mock["missing_service_record_denies"] := access(true) if
	is_access_lookup(input.request)

mock["missing_service_record_denies"] := echo if is_proxy_call(input.request)

# --------------------------------- appview_says_not_admin_denies ------------
#
# The AppView answering `isAdmin: false` denies the request.

cases["appview_says_not_admin_denies"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(mallory),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(mallory),
		],
		"result": default_deny,
	},
}

mock["appview_says_not_admin_denies"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["appview_says_not_admin_denies"] := record(appserver) if
	is_service_lookup(input.request)

mock["appview_says_not_admin_denies"] := access(false) if
	is_access_lookup(input.request)

mock["appview_says_not_admin_denies"] := echo if is_proxy_call(input.request)

# ------------------------------------------------- appview_failure_denies ---
#
# A failing AppView call (transport error, 5xx) denies the request.

cases["appview_failure_denies"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(alice),
		],
		"result": default_deny,
	},
}

mock["appview_failure_denies"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["appview_failure_denies"] := record(appserver) if
	is_service_lookup(input.request)

mock["appview_failure_denies"] := xrpc_err(502, "UpstreamError", "proxy request failed") if
	is_access_lookup(input.request)

mock["appview_failure_denies"] := echo if is_proxy_call(input.request)

# -------- recovery_failure_falls_through_to_appview_admin -------------------
#
# A failing recovery lookup does not deny an AppView admin: the else chain
# falls through to the Roomy check.

cases["recovery_failure_falls_through_to_appview_admin"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(alice),
			proxy_call("GET", "space.roomy.space.getMetadata", {}),
		],
		"result": {
			"ok": true,
			"output": {
				"mockProxied": true,
				"nsid": "space.roomy.space.getMetadata",
				"method": "GET",
			},
		},
	},
}

mock["recovery_failure_falls_through_to_appview_admin"] := record_not_found if
	is_recovery_lookup(input.request)

mock["recovery_failure_falls_through_to_appview_admin"] := record(appserver) if
	is_service_lookup(input.request)

mock["recovery_failure_falls_through_to_appview_admin"] := access(true) if
	is_access_lookup(input.request)

mock["recovery_failure_falls_through_to_appview_admin"] := echo if
	is_proxy_call(input.request)

# --------------------- malformed_service_record_did_denies ------------------
#
# A service record whose `did` is not a string must not crash the evaluation
# into a 500: the AppView check becomes undefined and the caller is denied.

cases["malformed_service_record_did_denies"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
		],
		"result": default_deny,
	},
}

mock["malformed_service_record_did_denies"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["malformed_service_record_did_denies"] := non_string_did if
	is_service_lookup(input.request)

mock["malformed_service_record_did_denies"] := access(true) if
	is_access_lookup(input.request)

mock["malformed_service_record_did_denies"] := echo if
	is_proxy_call(input.request)

# -------------------- non_admin_requests_pass_to_later_layers ---------------
#
# A community layer installed after the Roomy layer handles the requests the
# Roomy layer passes (non-admins and failed lookups); admin requests are
# still handled by the Roomy layer and never reach it.

cases["non_admin_requests_pass_to_later_layers"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(mallory),
	"extraLayers": [community_layer],
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(mallory),
		],
		"result": {"ok": true, "output": {"handledBy": "layer2"}},
	},
}

mock["non_admin_requests_pass_to_later_layers"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["non_admin_requests_pass_to_later_layers"] := record(appserver) if
	is_service_lookup(input.request)

mock["non_admin_requests_pass_to_later_layers"] := access(false) if
	is_access_lookup(input.request)

mock["non_admin_requests_pass_to_later_layers"] := echo if
	is_proxy_call(input.request)

# -------------------- admin_requests_do_not_leak_to_later_layers ------------
#
# ...and admin requests must not leak to later layers.

cases["admin_requests_do_not_leak_to_later_layers"] := {
	"request": {
		"method": "GET",
		"nsid": "space.roomy.space.getMetadata",
		"parameters": {},
	},
	"ctx": ctx(alice),
	"extraLayers": [community_layer],
	"expect": {
		"calls": [
			record_call("town.muni.arbiter.recovery"),
			record_call("space.roomy.service"),
			access_call(alice),
			proxy_call("GET", "space.roomy.space.getMetadata", {}),
		],
		"result": {
			"ok": true,
			"output": {"mockProxied": true, "nsid": "space.roomy.space.getMetadata"},
		},
	},
}

mock["admin_requests_do_not_leak_to_later_layers"] := record(appserver) if
	is_recovery_lookup(input.request)

mock["admin_requests_do_not_leak_to_later_layers"] := record(appserver) if
	is_service_lookup(input.request)

mock["admin_requests_do_not_leak_to_later_layers"] := access(true) if
	is_access_lookup(input.request)

mock["admin_requests_do_not_leak_to_later_layers"] := echo if
	is_proxy_call(input.request)