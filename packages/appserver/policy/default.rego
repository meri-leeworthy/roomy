#
# Roomy's shared arbiter policy, installed as the (single) layer of a Roomy
# space's policy pipeline.
#
# The layer receives:
#   input.callerDid    — the requester's DID (serviceAuth token `iss`)
#   input.arbiterDid   — the stewarded account's DID (the space)
#   input.pdsService   — the steward's PDS service reference (`did#atproto_pds`)
#   input.target       — the request's destination (`did#service`): the proxy envelope's caller-declared `target`
#   input.method       — the XRPC method ("GET"/"POST"/...)
#   input.nsid         — the XRPC method NSID
#   input.parameters   — query parameters (or null)
#   input.body         — the JSON body (or null)
#   input.encoding     — the request body encoding (or null)
#
# The layer's `data.arbiter.result` output is interpreted as one of:
#   { "handleBuiltin": true }                    → hand off: the request is
#     served by the arbiter's built-in handler (later layers are not run)
#   { "pass": true }                             → defer to the next layer
#   { "ok": true,  "output": <response body> }   → handle: forward the body
#   { "ok": false, "error": { status, error } }  → deny with an error
# Falling off the end of the pipeline (or an empty pipeline) denies.
#
# An admin — per the Roomy AppView, the recovery admin, or the space account
# itself — gets:
#   - Management requests (any `town.muni.arbiter.*` NSID) handed to the
#     arbiter's built-in handler.
#   - Every other request forwarded to the caller's declared destination
#     (`input.target` — the proxy envelope's `target`), authenticated
#     as the space account, via the `xrpc` host function.
# Everyone else is passed to the next layer: this layer only governs
# adminship, so community layers installed after it may handle (or deny)
# everyone else. When no layer handles a request, the pipeline denies it
# with its default 403 — including requests whose admin lookups failed,
# which pass through without matching an admin branch.
#
# Adminship sources, checked in this order (the first match wins, so a
# matching earlier source skips the later lookups):
#
#   1. The space account itself (`input.callerDid == input.arbiterDid`) —
#      the space's own service calls. No lookups.
#
#   2. The recovery admin named in the space's `town.muni.arbiter.recovery/self`
#      record — the Roomy appserver (`did:web:api.roomy.space`). Load-bearing:
#      the appserver's own proxy calls (e.g. the provisioning
#      `space.roomy.service/self` write) are authorized here, and the AppView
#      cannot answer for a space that is still being provisioned. This is also
#      the trust root the arbiter server itself gates `resetConfig` on,
#      outside of any policy.
#
#   3. The Roomy AppView: the policy reads the space's `space.roomy.service/self`
#      record (written by the appserver at provisioning time; its `did` field
#      names the appserver that hosts the space), then asks the appserver's
#      `space.roomy.space.getUserAccess` whether `input.callerDid` is an admin
#      of the space. The request is routed to the appserver's
#      `#space_roomy_appserver` service through the atproto proxy header,
#      authenticated as the space account — exactly the caller identity
#      `space.roomy.space.getUserAccess` requires. The AppView answers
#      `{ isAdmin: false, roleIds: [] }` for unknown users/spaces, so an
#      unmaterialized or missing state denies.

package arbiter

import rego.v1

# Non-admin callers — and callers whose admin lookups failed — are passed to
# the next pipeline layer. This layer only governs adminship; a community
# layer installed after it can handle (or deny) everyone else. When every
# layer passes (or none is installed), the pipeline denies with its default
# 403 (`Denied`).
default result := {"pass": true}

# The recovery admin designated in the space's own repo (rkey `self`), fetched
# through the `xrpc` host function against the steward's PDS. On success the
# envelope is `{ "ok": true, "output": <getRecord response> }`; on failure it
# is `{ "ok": false, "error": { status, ... } }` — in which case the
# recovery branch of `is_admin` below simply won't match.
recovery_resp := xrpc({
	"target": input.pdsService,
	"method": "GET",
	"nsid": "com.atproto.repo.getRecord",
	"parameters": {
		"repo": input.arbiterDid,
		"collection": "town.muni.arbiter.recovery",
		"rkey": "self",
	},
	"body": null,
	"encoding": null,
})

# The Roomy appserver that hosts this space, read from the space's own repo.
# The appserver writes this record at provisioning time (and the
# migrate-spaces-to-pds script wrote it for migrated spaces); its `did` field
# is the appserver DID (e.g. `did:web:api.roomy.space`).
service_resp := xrpc({
	"target": input.pdsService,
	"method": "GET",
	"nsid": "com.atproto.repo.getRecord",
	"parameters": {
		"repo": input.arbiterDid,
		"collection": "space.roomy.service",
		"rkey": "self",
	},
	"body": null,
	"encoding": null,
})

# The Roomy AppView's answer to "is the caller an admin of this space?". The
# endpoint requires the caller to BE the space's own DID, which is exactly
# what this authenticated-as-the-steward proxy call provides. The appserver
# DID is bound and type-checked inside the body so that a missing or
# malformed service record leaves this rule undefined (deny) instead of
# erroring the evaluation into a 500.
access_resp := resp if {
	did := service_resp.output.value.did
	is_string(did)
	resp := xrpc({
		"target": concat("#", [did, "space_roomy_appserver"]),
		"method": "GET",
		"nsid": "space.roomy.space.getUserAccess",
		"parameters": {
			"spaceId": input.arbiterDid,
			"userDid": input.callerDid,
		},
		"body": null,
		"encoding": null,
	})
}

# A caller is an admin when they are (in order, first match wins):
is_admin if input.callerDid == input.arbiterDid

else if {
	recovery_resp.ok
	recovery_resp.output.value.did == input.callerDid
}

else if {
	access_resp.ok
	access_resp.output.isAdmin == true
}

# Management NSIDs are served by the arbiter's built-in handler: a management
# request from an admin is handed off so the built-in handler can perform it,
# and any other caller is denied.
result := {"handleBuiltin": true} if {
	is_admin
	startswith(input.nsid, "town.muni.arbiter.")
}

# Admin-issued non-management requests are forwarded to the caller's declared
# destination — `input.target` (the proxy envelope's `target`) — as the
# stewarded account: the policy issues the request itself and returns the
# response; the xrpc ok/err envelope is exactly the layer's handle/deny
# output. The policy's internal lookups above stay pinned to the steward's
# PDS; only the forwarded destination follows the caller.
result := xrpc({
	"target": input.target,
	"method": input.method,
	"nsid": input.nsid,
	"parameters": input.parameters,
	"body": input.body,
	"encoding": input.encoding,
}) if {
	is_admin
	not startswith(input.nsid, "town.muni.arbiter.")
}
