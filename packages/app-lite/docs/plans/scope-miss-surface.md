# Scope-miss surface — one path from a missing scope to a session that has it

**Date:** 2026-10-13
**Status:** Proposed. One phase, dispatchable. Extends the shipped reactive
path in `progressive-scope-extension.md` (all six phases merged) rather than
reopening it.
**Packages:** `packages/app-lite`

## Goal

When a user action fails because the session's granted OAuth scope does not
cover it, the app must say what happened and offer the one action that can fix
it — never a bespoke string that promises a fix the build cannot deliver.

Today every feature writes its own copy and its own decision. Two examples, on
`origin/next`:

- `lib/mutations/blocks.ts:54` — `"Roomy does not have permission to manage your
  blocks on this session. Sign in again to grant it, then retry."` The advice is
  **false**: `repo:space.roomy.user.block` is ceiling-only (`UNREGISTERED_SCOPES`,
  `scopes.ts:188`), in no requestable tier, so every re-login requests `base`
  without it. Signing out and in cannot grant it, and the user learns the same
  sentence again.
- `lib/voice/voice-errors.ts:155` — `"This session is not allowed to use Roomy's
  voice endpoints. Sign in again once the server grants voice access."` Same
  shape, different words.

Neither is routed through the mechanism built for exactly this: the scope-miss
predicate (`isInsufficientScopeError`) and the consent dialogue.

## The three cases

A mid-request scope-miss is one event with three possible resolutions. The
current per-feature code cannot tell them apart because it never looks at *which*
scope is missing.

| Case | Missing scope lives in | What fixes it | Modal must offer |
|---|---|---|---|
| **Requestable capability** | a tier in `REQUESTABLE_SCOPE_SETS` (e.g. `semble`) | re-authorization, which the app can drive | "Grant permission" → `requestScopeExpansion(tier)` |
| **Ceiling-only feature** | a tier only in `DEFERRED_SCOPE_SETS` (e.g. `blocks`, `voice`) | nothing the app can drive — the scope is on the PDS ceiling but not on the HappyView API client, and requesting it makes HappyView reject the *whole* granted set at session registration, breaking sign-in for everyone | "Not available in this build yet" — no re-auth, no false promise |
| **Base scope on an old session** | `base` (a token added to `base` after the session was minted) | the next sign-in, which requests `base` afresh | "Sign in again" |

The block case is row 2. That is why re-login does not help, and why the honest
message is "not available yet" rather than "sign in again".

## Design

### 1. One decision, pure and testable — `scope-guard.ts`

Extract the missing token(s) from the error and classify. This is the whole
mechanism; the modal and the call sites are presentation over it.

```ts
/** Which scope-miss case this is, and the one action it implies. */
export type ScopeMissResolution =
  | { kind: "expand"; tier: RequestableScopeSetName }
  | { kind: "unavailable"; tier: ScopeSetName } // ceiling-only, cannot be requested
  | { kind: "reauth" }                          // base tier: next sign-in covers it
  | { kind: "unknown" };                        // no token recoverable

export function resolveScopeMiss(err: unknown): ScopeMissResolution;
```

Token extraction already has both wire shapes recorded in the shipped code
(`scope-guard.ts`):

- PDS: `Missing required scope "<token>"` (double-quoted).
- HappyView: ``this session is not authorized for <method>: it needs `<token>`. ``
  (back-ticked).

Then map the token to a tier by scanning `SCOPE_SETS`: a token in a requestable
tier → `expand`; a token in a deferred tier → `unavailable`; a token in `base`
only → `reauth`; nothing parsed → `unknown`. `resolveScopeMiss` returns
`unknown` for a non-scope-miss (`isInsufficientScopeError` stays the gate).

### 2. One modal, generic over the resolution — `scope-consent-dialogue.ts`

`ScopeConsentDialogue.svelte` already renders a title, a description, and an
accept that drives `requestScopeExpansion(tier)`. Generalize the entry point:

```ts
export function showScopeMissDialogue(
  decision: ScopeMissResolution,
  overrides?: { title?: string; description?: string },
): Promise<boolean>;
```

It derives the copy per kind — capability label from a `TIER_LABELS` map
(tier → "Save to your Semble collection", "Manage your blocks", …) so no call
site invents prose — and renders:
- `expand`: the existing Grant permission / Not now buttons.
- `unavailable`: a single Dismiss; no redirect, because none is possible.
- `reauth`: a Sign in again button that calls `logout()`/login.
- `unknown`: a plain failure.

Call sites that want domain framing (the message toolbar's "Create Space
cards") pass `overrides`; nothing else needs to.

### 3. `guardedXrpc` infers the tier — `scope-guard.ts`

Today `guardedXrpc` fires only when the caller passes **both** `requiredTier`
and `prompt`. That is the per-feature opt-in Meri is asking to delete. Make the
tier optional and the prompt default:

- No `requiredTier` → `resolveScopeMiss(err)` supplies the decision.
- No `prompt` → `showScopeMissDialogue` is the default.
- An explicit `requiredTier` still wins (it is the caller asserting "this call
  needs *this* tier"), and an explicit `prompt` still overrides the copy.

A call site can then be `guardedXrpc(() => blockUser(subject))` with nothing
else. It still never retries, so app-password/test mode cannot loop.

### 4. Route the two existing bespoke errors through it

- `blocks.ts`: delete `blockErrorMessage`'s scope branch; let `guardedXrpc`
  handle it. The block write's tier is `blocks`, deferred → the modal reads
  "not available yet", which is true.
- `voice-errors.ts`: same — the voice tier is deferred, so the message becomes
  the generic `unavailable` copy.

## Non-goals

- **Making blocking work.** That needs `repo:space.roomy.user.block` *and*
  `rpc:space.roomy.user.refreshBlocks?aud=*` registered on the HappyView API
  client (out of band), then the `blocks` tier moved from `DEFERRED_SCOPE_SETS`
  to `REQUESTABLE_SCOPE_SETS` — user-blocks Phase 6. This plan only stops the
  app from *lying* about it in the meantime.
- **A global `onError` hook.** The `QueryCache`/`MutationCache` `onError` already
  routes recoverable session errors to `error-recovery.ts`; a modal there would
  fire on background refetches, not user actions. Scope-misses are intercepted at
  user-action boundaries, which is where a modal is meaningful. Revisit only if a
  user action escapes `guardedXrpc` in practice.

## Acceptance

- A scope-miss on a requestable tier shows the capability modal and drives
  `requestScopeExpansion`.
- A scope-miss on a deferred tier shows "not available yet" and offers no
  redirect.
- Blocking a user no longer prints "Sign in again to grant it."
- Unit tests pin `resolveScopeMiss` on both wire shapes and all four kinds;
  the existing `isInsufficientScopeError`/`guardedXrpc` tests stay green.
