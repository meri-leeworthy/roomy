# Native Push — Plugin Distribution, Upstream Edits, and Rollout

**Date:** 2026-10-01 — **§4 rewritten as a staged plan 2026-10-09**
**Status:** Defects A and B fixed in the fork; C and the rollout steps below stand. macOS APNs is in scope, staged in §4.
**Related:** `native-push-plan.md` (the implemented transports and client wiring this follows on from), `web-push-plan.md`.
**Audience:** the agent (or human) planning the upstream/plugin edits and the production rollout.

This document records findings that are *not* in `native-push-plan.md`: how the
native push plugin is distributed, what is actually broken in it and where, what
the macOS path is and how it is staged, and the production
credential/provisioning steps. Everything below is anchored to a path + line that
was read; anything not directly observed is marked `[INFERENCE]`.

---

## 1. What the plugin is, and how it ships

Two artifacts, from one upstream repo — `github.com/yanqianglu/tauri-plugin-mobile-push`
(Apache-2.0 / MIT, ~10 stars, 1 fork, first release 2026-03):

| Artifact | Registry | Pinned in this repo | Consumed at |
|---|---|---|---|
| Rust crate `tauri-plugin-mobile-push` | crates.io (0.1.0, 0.1.3, 0.1.4 — 2026-04-18) | fork, `git` + `rev` | `packages/app-lite/src-tauri/Cargo.toml:38` |
| JS `tauri-plugin-mobile-push-api` | npm | `^0.1.4` | `packages/app-lite/package.json:38` |

**The load-bearing property:** the native code ships *inside the crate source
tree*, not as a prebuilt artifact. The crate's `Cargo.toml` declares

```toml
[package.metadata.tauri-plugin]
android-src = "android"
ios-src = "ios"
```

`tauri-plugin`'s build script reads that metadata and copies `android/` and
`ios/` out of the crate source into `gen/`. Consequences:

- Any fork **must** be consumed as a source dependency (git or path). A vendored
  `.aar`, a compiled artifact, or a patched `gen/` tree will not carry the
  native sources.
- `packages/app-lite/scripts/copy-android-assets.sh` is **not** an escape hatch: it only
  overwrites the files tauri-cli itself generates (`app/build.gradle.kts`,
  `app/src/main/AndroidManifest.xml`, root `build.gradle.kts`) from
  `src-tauri/android/`. It cannot patch the crate's Kotlin sources — those are
  copied by the crate's build script after `tauri android init`.
- The crate sets `links = "tauri-plugin-mobile-push"`. Two packages claiming that
  `links` key cannot coexist in one graph, so a fork must *replace* the crates.io
  dependency outright — never sit beside it.

---

## 2. Fork mechanics (fork: `muni-town/tauri-plugin-mobile-push`, consumed via `git` + `rev`)

### Fork target

The fork is **`muni-town/tauri-plugin-mobile-push`** — org ownership rather than
a personal account, since this is a load-bearing dependency of a shipped app and
the fork belongs where the build does. The `rev` pin makes any later move a
one-line dependency change.

### Consuming it — no crates.io publish

`packages/app-lite/src-tauri/Cargo.toml:38` is:

```toml
[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]
tauri-plugin-mobile-push = { git = "https://github.com/muni-town/tauri-plugin-mobile-push", rev = "6ac0683c7b0b45794a392452bc2d8e7db73042cd" }
```

- **Pin `rev`, not `branch`.** A git dependency carries no semver, so `rev` is the
  only thing making the mobile build reproducible.
- **Do not use `[patch.crates-io]`.** It is honoured only in a workspace-root
  manifest. `packages/app-lite/src-tauri` is a standalone package: there is no
  root `Cargo.toml` and no `[workspace]` anywhere (verified). A direct git
  dependency is simpler and avoids patch-resolution surprises with the `links` key.
- **Publishing to crates.io would hurt.** Crate names are first-come, so the fork
  cannot publish under `tauri-plugin-mobile-push`; it would need a new name, which
  every consumer must then change in the dependency line. Not worth it for a
  single-repo fork. `git` + `rev` is the mechanism upstream's own README offers.

### Keep the npm side on upstream

The Android defect is Rust-side (see §3), and it does **not** change the JS
surface (`requestPermission`, `getToken`, `onTokenRefresh`,
`onNotificationReceived`, `onNotificationTapped` — see
`github.com/yanqianglu/tauri-plugin-mobile-push/blob/main/guest-js/index.ts`).
So `tauri-plugin-mobile-push-api@^0.1.4` from npm keeps working unchanged.

Only fork npm if the JS API changes; then use
`"tauri-plugin-mobile-push-api": "github:muni-town/tauri-plugin-mobile-push#path:/guest-js"`.
Note `guest-js/dist/` is **committed** in the upstream repo, so a JS fork must
rebuild and commit `dist` or the import resolves to stale output.

**Net effect: one dependency swapped, not two.**

### `Cargo.lock` recorded no entry, and has been regenerated

`packages/app-lite/src-tauri/Cargo.lock` is tracked in git, last touched by
`2279a7b2d` (the desktop-updater PR) — i.e. **before** the push PR. It contained
**zero** occurrences of `tauri-plugin-mobile-push`, and the
`[[package]] name = "app"` dependency list omitted the crate entirely.

That the lock *does* record target-gated dependencies is proven by android-only
`jni` (present, twice) and macOS-only `objc2` — so the absence was not a
host-target artifact; the lock simply predated the dependency.

It is now regenerated and committed alongside the dependency change:
`cargo metadata --locked` in `packages/app-lite/src-tauri` succeeds, where it
previously failed with

```
error: cannot update the lock file .../Cargo.lock because --locked was passed to prevent this
```

CI passes no `--locked`/`--frozen` to cargo (only pnpm uses
`--frozen-lockfile`), and `pnpm tauri android build --apk` /
`pnpm dlx @tauri-apps/cli@2.12.0 ios build` run cargo unlocked — but the
committed lock is what makes the mobile build reproducible.

---

## 3. What was broken in 0.1.4, and where it was fixed

Upstream `src/commands.rs` (verified by reading the file on `main`):

```rust
#[cfg(target_os = "ios")]  { /* real FFI: mobile_push_request_permission() */ }
#[cfg(not(target_os = "ios"))] { Ok(PermissionResponse { granted: false }) }   // request_permission
#[cfg(not(target_os = "ios"))] { Ok(TokenResponse { token: String::new() }) }  // get_token
```

and `src/lib.rs` registers those Rust handlers:

```rust
.invoke_handler(tauri::generate_handler![
    commands::request_permission,
    commands::get_token,
    commands::register_listener
])
```

### Defect A — Android commands are shadowed by the crate's own Rust stubs

The Rust `request_permission`/`get_token` commands are registered on every
target. On Android Tauri dispatches the crate's Rust command before the native
Kotlin plugin, so the `#[cfg(not(target_os = "ios"))]` arms win and always resolve
`{ granted: false }` / `{ token: "" }`.

Confirmed by the Kotlin side
(`android/.../MobilePushPlugin.kt`), which implements real `getToken` via
`FirebaseMessaging.getInstance().token` and `requestPermissions` via
`requestPermissionForAlias` — none of which is ever reached.

**Fixed** (fork `6ac0683`): both commands forward to the Kotlin plugin with
`run_mobile_plugin_async`, and only the `#[cfg(desktop)]` arm short-circuits.
The name mismatch the original note flagged is real — the Kotlin command is
`requestPermissions` (plural, the framework's permission-override name) — so the
forward uses that name while the JS-facing command stays `request_permission`.
On Android the Kotlin plugin also handles the below-API-33 case by resolving
`granted: true` directly, since there is no runtime permission to request.

### Defect B — event listeners never fire (both platforms)

- Android: `register_listener` is a Rust **no-op** returning `Ok(())`, whose
  comment states events are "not yet delivered through this path".
- iOS: the plugin's own README states `trigger()` cannot reach the webview.

The cause is the same on both: `Plugin::trigger` sends to listeners held by the
plugin object Tauri's dispatch instantiated, and this plugin bypasses that
dispatch on iOS. `AppHandle.emit` is not a substitute either — `addPluginListener`
subscribes a `Channel`, not a Tauri event, so the payloads would not reach it.

**Fixed** (fork `6ac0683`): the listener registry lives in Rust
(`src/events.rs`). `register_listener` stores the channel Tauri deserialized
from the `__CHANNEL__:<id>` string, `remove_listener` drops it, and each platform
emits into it:

- iOS calls `mobile_push_emit_event` (declared `@_silgen_name`, defined in
  `src/ios.rs`) from the notification-center delegate and the APNs token callback.
- Android calls its `emitEvent` native method, resolving to the JNI symbol
  `Java_app_tauri_mobilepush_MobilePushPlugin_emitEvent` in `src/commands.rs`.

Both platforms emit the same names and shape — `notification-received`,
`notification-tapped`, `token-received`, each `{ title?, body?, data }` — so the
client's existing `routeFromEvent`/`navigateFromEvent` read one contract.

A `notification-tapped` that arrives before any listener has registered (a cold
start from the tap) is held and replayed to the first listener, so the routing
code installed during startup still sees the notification that launched the app.
Android's tap payload comes from the activity lifecycle — the FCM SDK copies the
message `data` onto the launch intent — with `load` covering the cold start and
`onNewIntent` the running app; the extras are cleared so a re-delivered intent
emits once.

### Defect C — no desktop/macOS implementation at all

Upstream `src/lib.rs` selects `#[cfg(desktop)] mod desktop` — and
`src/desktop.rs` is an empty stub whose own comment says commands "return stub
values on desktop (push notifications are mobile-only)". The README's platform
table lists Desktop as "No-op".

So macOS is **not** a matter of flipping cfg flags; there is no APNs
implementation for macOS to enable. Writing it is stage 0 in §4.

### What already works

iOS `requestPermission()` and `getToken()` work, via direct `@_cdecl` FFI into
Swift (bypassing Tauri's `run_mobile_plugin` dispatch entirely). The token is the
lowercase-hex APNs device token, registered with `kind: "apns"`.

---

## 4. Desktop / macOS: the staged plan

**Decided 2026-10-09: macOS APNs is in scope.** This section is the plan. The
four gates below were re-verified against `next` at `8b863f13` and fork rev
`6ac0683c` (`Cargo.toml:38`); the one correction is gate 2's fallback. All line
anchors were read this run.

macOS is four independent changes, one of which is missing code rather than a
setting. None is large on its own. The stages below are ordered so that every
stage before §4.6 is verifiable from a Linux checkout; §4.6 is blocked on Apple
account assets, not on engineering.

### 4.0 The four gates

1. **Plugin not registered on desktop.** `packages/app-lite/src-tauri/src/lib.rs:16-25`
   registers the plugin inside `#[cfg(mobile)]` (android + iOS only). The Cargo
   dependency is likewise gated to
   `cfg(any(target_os = "android", target_os = "ios"))`
   (`Cargo.toml:37-38`).
2. **Client refuses to classify desktop as a push platform.**
   `nativePushPlatform()` (`native-push.ts:123-127`) returns `null` unless the
   shell reports `ios`/`android`; the type is literally
   `NativePushPlatform = "ios" | "android"` (`native-push.ts:44`). Because
   `nativePushSupported()` is false on macOS, every entry point in
   `push.svelte.ts` (`:136`, `:173`, `:204`, `:308`) takes the **Web Push** branch
   instead — and on macOS that branch is a dead end, not a working fallback:
   WebKit compiles Web Push on macOS (`Source/WTF/wtf/PlatformEnableCocoa.h:244-246`,
   `ENABLE_WEB_PUSH_NOTIFICATIONS` for `PLATFORM(MAC)`) but both gates that turn it
   on are embedder-set: `PushAPIEnabled` is `status: embedder`, default `false`,
   and `BuiltInNotificationsEnabled` defaults to `false`
   (`Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`;
   `WebPreferencesDefaultValues.cpp:337-352`). Neither tao 0.35.3
   (`src/platform_impl/macos/view.rs`) nor wry 0.55.1
   (`src/wkwebview/mod.rs`) sets either preference (grepped this run: zero hits).
   So the desktop `.app` currently has **no push of any kind** — and no `PushManager`
   at all, which is why the settings page renders its "unsupported" branch there.
3. **Capability is desktop-excluded on purpose.**
   `capabilities/mobile.json:6` sets `"platforms": ["android", "iOS"]`, with an
   in-file comment explaining that tauri-build skips a capability whose
   `platforms` exclude the target *before* validating the unknown
   `mobile-push:default` permission — that skip is what keeps desktop builds from
   failing. Adding macOS requires making the Rust dependency unconditional for
   macOS first.
4. **No macOS implementation exists** (Defect C above): the pinned fork's
   `src/desktop.rs` is an `AppHandle`-only stub, and both desktop arms of
   `src/commands.rs` short-circuit (`{ granted: false }` /
   `Err(Unsupported)`). The README's platform table lists Desktop as "No-op".

Windows and Linux have no APNs path under any change — Windows would be WNS,
Linux a browser-engine push service; neither exists in this repo.

### 4.1 Gate → stage map

| Gate | Closed by | Verifiable on Linux |
|---|---|---|
| 1. Plugin not registered on desktop | Stage 2 (app wiring) | yes — `cargo check --target aarch64-apple-darwin` |
| 2. Client refuses to classify macOS as a push platform | Stage 1 (client) | yes — unit test |
| 3. Capability is desktop-excluded on purpose | Stage 2 (app wiring) | yes — build-script ACL output |
| 4. No macOS implementation exists | Stage 0 (fork) | yes — `cargo check`, both Darwin targets |

Stages 0-2 are code. §4.6 is the Apple account work and is the only part that
cannot be exercised without hardware and a paid membership.

### 4.2 Stage 0 — de-risk the fork implementation (no Apple account)

**Goal.** Turn gate 4 from "unknown work" into "a known quantity with a compiling
prototype", before anything in the app depends on it.

**Where.** The fork, `meri-leeworthy/tauri-plugin-mobile-push` (the personal fork
has push access; the `muni-town` org fork is read-only for this integration —
§2). The macOS arm is a *new* module beside `desktop.rs`, not a rewrite of it:
the existing `#[cfg(desktop)]` module keeps serving Windows and Linux, where
there is no push service to talk to and the current stub answers correctly.

**What.** `src/desktop.rs` is 13 lines and its own comment says the commands
"return stub values on desktop". The macOS implementation has to supply:

- **Delegate injection.** tao installs its own dynamic delegate class
  (`TaoAppDelegateParent`, a `NSResponder` subclass) as `NSApplication.delegate`
  inside `EventLoop::new`, which runs before any plugin `setup`
  (`tao-v0.35.3` `src/platform_impl/macos/app_delegate.rs:47-88`;
  `src/platform_impl/macos/event_loop.rs:161-180`). The class is registered
  already, so it can receive `class_addMethod`-added methods but cannot receive
  new ivars — the plugin's state lives in a process-global instead. This is the
  same technique the fork's iOS Swift already uses
  (`ios/Sources/MobilePushPlugin.swift`, `setupApnsDelegateInternal`), with
  `NSApplication` for `UIApplication`.
- **Two selectors, added to whatever class is the delegate at runtime**
  (its name is not knowable at compile time):
  `application:didRegisterForRemoteNotificationsWithDeviceToken:`
  (`v@:@@`, `NSApplication` + `NSData`) and
  `application:didFailToRegisterForRemoteNotificationsWithError:`
  (`v@:@@`, `NSApplication` + `NSError`). Both exist as `#[optional]` members of
  `NSApplicationDelegate` in `objc2-app-kit` 0.3.2
  (`generated/NSApplication.rs`).
- **Registration.** `NSApplication.registerForRemoteNotifications()` (macOS
  10.14+) on the main thread; the token arrives asynchronously on the delegate
  above.
- **Foreground presentation and taps.** A retained
  `UNUserNotificationCenterDelegate` set on
  `UNUserNotificationCenter.currentNotificationCenter()`, implementing
  `userNotificationCenter:willPresentNotification:withCompletionHandler:` and
  `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:`
  (both `v@:@@@`; macOS 10.14+). The center holds its delegate **weakly**, so it
  must be stored in a `LazyLock` static. The existing
  `ForegroundPresentationOptions::to_bitmask` (`src/lib.rs:87-95`) already
  matches objc2's `UNNotificationPresentationOptions` bit layout
  (badge 1<<0, sound 1<<1, list 1<<3, banner 1<<4), so it is reused as is.
- **Events.** `event::emit` is `#[cfg(any(mobile, test))]`
  (`src/events.rs:104-105`) — compiled out on macOS. Widen that cfg; the registry
  itself (`register`/`remove`/`clear`) has no cfg and already works on macOS.
- **Commands.** `commands.rs` answers `request_permission` with
  `{ granted: false }` and `get_token` with `Err(Unsupported)` under
  `#[cfg(desktop)]` (`:78-82`, `:123-128`). Those need `#[cfg(target_os =
  "macos")]` arms — permission via
  `UNUserNotificationCenter.requestAuthorizationWithOptions`, token via
  `registerForRemoteNotifications` plus a wait for the delegate callback, the
  same semaphore shape the Swift `TokenFetcher` uses.

**Dependencies.** `objc2`, `objc2-app-kit`, `objc2-foundation` and
`objc2-user-notifications` are already resolved in the consumer's lock
(`Cargo.lock`: `objc2` 0.6.4, `objc2-app-kit`/`objc2-foundation`/
`objc2-user-notifications` 0.3.2, `block2` 0.6.2), so nothing is added to the
graph — but the *fork* has to declare them, since a crate's own `Cargo.toml` is
what enables its features.

**Verified this run.** A prototype of exactly this shape compiles for both
Darwin targets from this Linux box:

```
cargo check --target aarch64-apple-darwin    # Finished
cargo check --target x86_64-apple-darwin     # Finished
cargo check --target x86_64-pc-windows-msvc  # Finished (the stub is intact)
```

It is pushed as `hedgehog/macos-apns-prototype` on the fork — a starting point
for stage 0, not a merge candidate: it has no tests, the permission wait is
sketchy (two different synchronisation shapes for two callbacks), and none of it
has run.

`cargo check` needs `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
and a `clang` with the Darwin driver (`CC_aarch64_apple_darwin=clang`, from the
Ubuntu `clang` package). That is what makes stages 1-3 testable without a macOS
runner. It is a **type/borrow check, not a run**: nothing about APNs on this path
is exercised, and stage 4 is still the first real evidence.

**Acceptance.** Both targets check clean; `cargo check` (host) is unchanged from
its baseline; the JS surface (`guest-js/index.ts`) is untouched, so
`tauri-plugin-mobile-push-api` stays on upstream npm (§2).

**Risk to settle here.** `class_addMethod` returns `YES` only if the class does
not already implement the selector, and tao's delegate implements none of the
APNs selectors — verified by reading the complete set it registers. If any other
plugin ever adds the same selector, the first implementation wins silently; the
return value must be checked rather than discarded.

### 4.3 Stage 1 — the client (no Apple account)

**Goal.** Let `native-push.ts` classify macOS as a push platform.

**What.** `NativePushPlatform` is `"ios" | "android"` (`native-push.ts:44`) and
`nativePushPlatform()` returns `null` for anything else (`:123-127`). The shell
reports `macos` (`@tauri-apps/plugin-os`'s `Platform` union includes it), so this
is a union widening plus one branch. `registerNativeToken` maps platform →
transport kind (`:151`, `kind: platform === "ios" ? "apns" : "fcm"`) and needs a
third arm: macOS is **`apns`**, not a new kind — the appserver's APNs transport
is already `iOS / iPadOS / macOS`
(`packages/appserver/src/push/transports/apn.ts`, file header) and
`PUSH_TRANSPORT_KINDS` already carries it. Nothing server-side changes.

**Why this is separable.** Every other consumer reads the platform through
`nativePushSupported()` — `push.svelte.ts:136`, `:173`, `:204`, `:308` and the
settings page (`+page.svelte:35`) — so widening the union flips all of them at
once, including the settings page's `isNative` branch, which then shows the
device-token state instead of the "unsupported browser" copy.

**Acceptance.** A unit test over the platform→kind mapping and
`nativePushPlatform()`'s three-way result. This is testable with `bun`/`vitest`
today; no shell, no entitlement.

**Ordering.** Land stage 1 *after* stage 0's prototype is in the fork, not
before: with the client flipped and the shell still stubbed, macOS users get a
"enable notifications" button that fails at `requestPermission`. The two stages
should go out together even though they live in different repos.

### 4.4 Stage 2 — the app wiring (no Apple account)

**Goal.** Close gates 1 and 3.

**What.** Four edits in `packages/app-lite/src-tauri`:

1. `Cargo.toml:37-38` — the dependency's target gate gains
   `target_os = "macos"`. Cargo's `cfg()` there is evaluated against the *target*
   triple and knows only `target_os`, not Tauri's build-script `desktop`/`mobile`
   aliases — and `desktop` is defined as `!mobile`, so a plugin arm written under
   `#[cfg(desktop)]` runs on Linux too. The gate in the manifest is what keeps
   the crate off Linux, and it has to name macOS explicitly.
2. `src/lib.rs:16-25` — register the plugin for macOS too. The current
   `#[cfg(mobile)]` block also calls `.ios_foreground_presentation(...)`; on
   macOS that setter is inert, so the cleanest shape is to register the plugin
   under a wider cfg and keep the iOS-only builder call inside it.
3. `capabilities/mobile.json:6` — `"platforms"` gains `"macOS"`. The exact
   accepted strings are `macOS`/`iOS`/`windows`/`linux`/`android`
   (`tauri-utils` `src/platform.rs:24-40`, `#[serde(rename = "macOS")]`);
   `macos` and `darwin` are **not** accepted, and an unknown value fails
   deserialisation of the whole capability file rather than being skipped.
   The in-file comment about the skip-before-validation behaviour stays true —
   tauri-build skips a capability whose `platforms` exclude the target before
   validating its permissions (`tauri-build` `src/acl.rs`, `validate_capabilities`).
4. `Cargo.lock` — regenerated for the new rev and target.

**Acceptance.** `cargo check --target aarch64-apple-darwin` in
`packages/app-lite/src-tauri` — but note the app crate cannot be cross-checked
from Linux: `ring` (via `tauri-plugin-http` → `rustls`, and `tauri-plugin-updater`
→ `rustls`) compiles C through `cc-rs`, which needs a Darwin sysroot this box
does not have (`fatal error: 'bits/libc-header-start.h' file not found`). The
fork crate has no such dependency, which is why stage 0's check works and stage
2's does not. So stage 2's real gate is CI or a macOS machine.

**Risk to settle here.** Registration on macOS means the plugin's `setup` runs
there, and `mobile::setup`'s build script takes `_ => ()` for a macOS *target* —
so nothing about the native sources changes, but the plugin must not reference
the iOS-gated `mobile` module from the macOS arm.

### 4.5 Stage 3 — the appserver (no Apple account, nothing to build)

**Goal.** Confirm the delivery side already covers macOS.

**What.** Nothing to build. `apn.ts` is transport-agnostic across Apple
platforms, `APNS_TOPIC` is the bundle id `space.roomy` (same identifier as iOS),
and macOS tokens register under the existing `kind: "apns"` row. The one
behavioural difference worth writing down: a macOS app's token is scoped to the
same App ID, so the same `.p8` key and topic serve both.

**Acceptance.** `space.roomy.admin.push.testSend` against a macOS token, which
is stage 4.

### 4.6 Stage 4 — Apple account work, and the part that is not a config toggle

This is the stage that needs a paid membership, a macOS runner, and hardware.
It is also the stage where the previous write-up's cost estimate was wrong in
the *optimistic* direction, and it is worth being precise about why.

**(a) Entitlement.** macOS uses a *different key* from iOS:
`com.apple.developer.aps-environment` (Apple, "APS Environment (macOS)
Entitlement"; macOS 10.14+), not iOS's `aps-environment`. Both come from
enabling Push Notifications on the App ID `space.roomy`. The value is
`development` or `production` and must match the profile (§5.1-5.2).

**(b) It is a *restricted* entitlement, so a profile must authorise it.** Apple
(TN3125): "restricted entitlements must be authorized by a provisioning
profile", "Every entitlement claimed by the app must be in the profile's
allowlist", and macOS "expects to find the profile at
`MyApp.app/Contents/embedded.provisionprofile`". Apple's macOS capability matrix
confirms **Push notifications is available for Developer ID** (not just ADP), so
a Developer ID profile with the entitlement is the mechanism for a non-App-Store
`.app`.

**Tauri cannot embed that profile.** `MacConfig` has no `provisioningProfile`
field and no macOS code path writes `Contents/embedded.provisionprofile` — the
only affordance is the documented workaround of shipping the file through
`bundle.macOS.files` (`MacConfig.files` is "the files to include in the
application relative to the Contents directory", copied by
`copy_custom_files_to_bundle` *before* signing). That is the hook to use, and it
works — but it means checking in a binary `.provisionprofile` or fetching it in
CI, not setting a config key.

**(c) Signing identity: a Developer ID cert, not the distribution cert already
held.** Notarisation requires "a 'Developer ID' application ... certificate ...
(Don't use a Mac Distribution, ad hoc, Apple Developer, or local development
certificate.)" The `APPLE_CERTIFICATE` secret the iOS job uses is asserted to be
an **Apple Distribution** identity (`release-tauri.yml:289-294`), which is the
wrong certificate type here. A Developer ID Application certificate is a new
account asset.

**(d) The release pipeline changes shape.** `publish-tauri` builds both macOS
targets through `tauri-action` with only updater-signing env
(`release-tauri.yml:154-167`); there is no `bundle.macOS` block in
`tauri.conf.json` and no Apple signing variable on that job, so the shipped
desktop `.app` is **unsigned today**. Two consequences:

- tauri-bundler notarises automatically as part of `tauri build` whenever
  credential env is present (`macos/app.rs`: "notarization is required for
  distribution" → `notarize_auth()`, then `xcrun notarytool submit --wait` +
  `xcrun stapler staple`) — so the *automatic* effect of adding the credentials
  is that the desktop release becomes signed **and notarised**, which is a
  change to the desktop trust story beyond what push requires. It is not
  optional once the entitlement is claimed: an entitled, unsigned build would
  simply fail registration.
- The App Store Connect API key secrets the iOS job already has
  (`APPLE_API_KEY`, `APPLE_API_ISSUER`) are the *same variables* tauri-bundler's
  `notarize_auth()` reads for its `ApiKey` path, so `notarytool` auth is already
  provisioned. The `.p8` needs to be on disk for the macOS job the way the iOS
  job already arranges it (`API_PRIVATE_KEYS_DIR`,
  `release-tauri.yml:307-315`).

**(e) Updater signing is independent.** `TAURI_SIGNING_PRIVATE_KEY` is minisign
(`tauri-cli` `src/bundle.rs`), unrelated to `codesign`/`notarytool`; adding
Apple signing does not disturb it.

**Acceptance for stage 4.** In order, each observable:

1. A signed, entitled, notarised `.app` whose
   `codesign -d --entitlements :-` shows `com.apple.developer.aps-environment`
   and whose `Contents/embedded.provisionprofile` decodes to a profile whose
   allowlist contains it.
2. `requestPermission()` returns `{ granted: true }` and `getToken()` returns 64
   hex characters — the same shape iOS already returns.
3. `space.roomy.admin.push.testSend` to that token reports `delivered`.

**The one thing that cannot be pre-verified.** Whether the Developer ID profile
Apple issues actually carries the entitlement allowlist. The matrix says the
capability is supported for Developer ID; it does not follow that the portal
will issue it for this App ID without a trial. This is the first thing to try in
stage 4 and the only genuine unknown left in the plan.

### 4.7 What stays out of scope

Windows and Linux have no APNs path under any change — Windows would be WNS,
Linux a browser-engine push service; neither exists in this repo. They keep the
existing `desktop.rs` stub, which is why the macOS arm is a new module rather
than a replacement.

The Web Push fallback (gate 2) remains a dead end on macOS: WebKit compiles Web
Push there (`PlatformEnableCocoa.h:244-246`) but both gates that enable it are
embedder-set and default `false` (`PushAPIEnabled`, `BuiltInNotificationsEnabled`),
and neither tao 0.35.3 nor wry 0.55.1 sets either. That is a *separate* piece of
work — an embedder-preference change plus an app-side `PushManager` path — and it
is not needed once APNs works, since the native path supersedes it in the shell.

### 4.8 Open questions

- **Cold-start taps.** Apple: "If you implement
  `applicationDidFinishLaunching(_:)` and a push notification for the application
  has recently arrived, this method [`didReceiveRemoteNotification:`] is not
  invoked for that push notification" — the payload has to be read from the
  launch `NSNotification.userInfo` (`NSApplicationLaunchRemoteNotificationKey`)
  instead. tao *does* implement `applicationDidFinishLaunching:`, so a macOS arm
  that wants cold-start routing must hook that path, not just the center
  delegate. iOS already solved the equivalent with a sticky tap
  (`src/events.rs`, `PENDING`), and the Android side has its own answer; macOS
  needs the third.
- **Bundle contents vs the appserver payload.** The APNs transport sends the
  route as a JSON *string* under a top-level `roomy` key because the iOS plugin
  projects `userInfo` to JS copying only String/NSNumber values. The macOS arm
  should keep that contract rather than reading nested dictionaries, so one JS
  reader (`routeFromEvent`) serves all three platforms.
- **`minimum_system_version`.** `tauri.conf.json` sets no `bundle.macOS` block,
  so the bundler default is `10.13` — below `registerForRemoteNotifications`'s
  macOS 10.14 floor. The gate should be raised when the macOS block is added.
- **Notarisation and the updater.** Whether an updater-downloaded `.app` swap
  draws Gatekeeper/quarantine scrutiny independent of the notarised first
  install is not stated by Apple, and Tauri's updater neither sets nor clears
  `com.apple.quarantine`. `[INFERENCE]`: the stapled first install is what
  Gatekeeper checks. Worth confirming on hardware rather than assuming.
- **Upstreaming.** The macOS arm is as general as defects A and B (§7), so it
  belongs in the same upstream offer.

### 4.9 Decision record

Decided 2026-10-09: **implement macOS APNs**, in the four stages above. This
supersedes the 2026-10-09 decision to scope native push to iOS + Android only,
which rested on a cost estimate that treated the whole path as unverifiable from
this environment. Stage 0's prototype check shows that is true of stage 4 only:
the fork implementation (stage 0), the client (stage 1) and the app wiring
(stage 2) all compile or test here, and the Apple account work is a known list
of assets rather than an unknown amount of code.

Stage 4's blocker is an account, not an engineer: **a Developer ID Application
certificate, an App ID carrying Push Notifications, a Developer ID provisioning
profile with `com.apple.developer.aps-environment`, and a macOS machine to run
the resulting build on.**

---

## 5. Production rollout: APNs credentials and provisioning

### 5.1 App ID capability

The App ID `space.roomy` (must match `identifier`) needs **Push Notifications**
enabled. The same capability entry covers both platforms; it writes
`aps-environment` into an iOS entitlement and
`com.apple.developer.aps-environment` into a macOS one (Apple, "Registering your
app with APNs"). *Broadcast Push Notifications* / Live Activities are **not** used
by this codebase: the only APNs request built is an alert push to
`/3/device/<device token>` with `apns-push-type: alert`
(`packages/appserver/src/push/transports/apn.ts:186-204`); repo-wide there is no
Live Activity, ActivityKit, broadcast channel id, or `aps-environment` usage
beyond the entitlement step. Skip the broadcast capability.

For macOS the profile is a **Developer ID** profile, not the App Store Connect
one §5.2 regenerates — Apple's macOS capability matrix lists Push notifications
as available to Developer ID — and it must be embedded at
`Contents/embedded.provisionprofile` (§4.6).

### 5.2 Regenerating the provisioning profile

An existing profile keeps its old entitlement allowlist; enabling the capability
does not propagate to it.

1. Identifiers → App ID `space.roomy` → confirm Push Notifications is checked.
2. Profiles → the **App Store Connect** distribution profile → Edit → Save
   (regenerates with current entitlements). If the capability still doesn't appear,
   delete and recreate the profile.
3. Confirm it is linked to the **Apple Distribution** certificate held in
   `APPLE_CERTIFICATE`. The workflow asserts the `.p12` holds exactly one Apple
   Distribution identity and no Development cert
   (`release-tauri.yml:257-304`).
4. Verify before uploading — this is the exact thing export fails on:

   ```bash
   security cms -D -i ~/Downloads/space_roomy.mobileprovision \
     | plutil -extract Entitlements xml1 -o - - | grep -A1 aps-environment
   ```

   Must print `production`. The workflow writes `production` into the
   entitlements file (`release-tauri.yml:424`); the profile is what authorises it.
5. Update the `APPLE_MOBILE_PROVISION` repo secret with
   `base64 -i <profile>.mobileprovision` (mapped to `IOS_MOBILE_PROVISION` at
   `release-tauri.yml:328` and `:489`). No device list to re-add — App Store
   Connect profiles are not device-scoped, unlike Ad Hoc.

### 5.3 Appserver env

Read from `process.env` at transport import
(`packages/appserver/src/push/transports/apn.ts:282-293`); they belong to the
appserver deployment (per `.env.example`), not the app repo or CI.

| Var | Source | Notes |
|---|---|---|
| `APNS_AUTH_KEY` | Developer portal → **Keys** → + → enable "Apple Push Notifications service (APNs)" | The `.p8` contents; downloadable **once**. |
| `APNS_KEY_ID` | The key's row / `AuthKey_<KEYID>.p8` filename | 10 chars; sent as JWT `kid`. |
| `APNS_TEAM_ID` | **Membership details** | 10 chars; the `iss` claim. |
| `APNS_TOPIC` | Defaults to `space.roomy` | The bundle id. |
| `APNS_ENVIRONMENT` | Defaults to `production` | Selects `api.push.apple.com`. |

**Two easy-to-confuse `.p8` files:** `APPLE_API_KEY` (App Store Connect API key,
from App Store Connect → Users and Access → Integrations) is *not*
`APNS_AUTH_KEY` (Developer portal → Keys, with the APNs service enabled). Both are
ES256 `.p8`; both parse; they are not interchangeable. There is no certificate
(`.p12`) path in this codebase at all — `apn.ts:109-124` builds a provider JWT from
the `.p8`.

**Encoding.** `authKeyDer()` (`apn.ts:94-107`) accepts raw PEM, PEM with literal
`\n`, or base64-of-PEM. Prefer base64 for a single-line secret store:
`base64 -i AuthKey_<KEYID>.p8`. A value that is neither PEM nor base64-of-PEM
makes `isConfigured()` return false (`apn.ts:208-219`), which surfaces as
`skipped` deliveries in `space.roomy.admin.push.getStats` — a silent-looking
config error, not a crash.

### 5.4 Two operational traps

- **A wrong `APNS_TOPIC` prunes devices.** `DeviceTokenNotForTopic` is in
  `PRUNE_REASONS` (`apn.ts:59-65`), maps to `gone` (`apn.ts:258`), and the
  dispatcher prunes the row. A topic typo silently unsubscribes the device.
- **Credential changes need a process restart.** The transport caches the imported
  key and the minted provider token for the process lifetime, and only drops the
  token on `403 ExpiredProviderToken` (`apn.ts:85-87`, `:262-266`).
  `403 InvalidProviderToken` does **not** refresh it, so editing env vars is not
  enough; redeploy/restart.

### 5.5 Triage: `403 InvalidProviderToken`

Apple: "the provider token is not valid, or the token signature can't be
verified". It maps to `retry`, not `gone` (`apn.ts:258-271`) — nothing is pruned.
Cause is one of, ranked:

1. `APNS_KEY_ID` does not match the `.p8` in `APNS_AUTH_KEY` (several keys created).
2. The App Store Connect API key was pasted instead of the APNs key (see §5.3).
3. `APNS_TEAM_ID` is wrong (must be the Membership-details team, not necessarily the
   identifier's App ID Prefix).
4. Environment mismatch: a sandbox-scoped key against the production host.

See `native-push-plan.md` → "Open questions" for the remaining follow-ups
(per-transport rate budgets, Notification Service Extension, badge counts).

---

## 6. Verification recipes

```bash
# What the provider JWT actually contains (no network). Runs the same jwt.ts the
# transport uses; compare `kid` to the .p8 filename and `iss` to Membership details.
cd packages/appserver
APNS_AUTH_KEY='...' APNS_KEY_ID='...' APNS_TEAM_ID='...' bun -e '
import { importSigningKey, pemToDer, signJwt } from "./src/push/transports/jwt.ts";
const raw = process.env.APNS_AUTH_KEY;
const pem = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
const der = pemToDer(pem.includes("-----BEGIN") ? pem : Buffer.from(pem, "base64").toString("utf8"));
const jwt = await signJwt("ES256", await importSigningKey("ES256", der),
  { alg: "ES256", kid: process.env.APNS_KEY_ID },
  { iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
console.log("header:", Buffer.from(jwt.split(".")[0], "base64url").toString());
console.log("claims:", Buffer.from(jwt.split(".")[1], "base64url").toString());
console.log("jwt:", jwt);
'

# Raw APNs answer for one device (use a PRODUCTION token from a TestFlight build).
curl -v --http2 \
  -H "authorization: bearer <jwt from above>" \
  -H "apns-topic: space.roomy" -H "apns-push-type: alert" \
  -d '{"aps":{"alert":"diag"}}' \
  https://api.push.apple.com/3/device/<64-hex device token>
```

Server-side diagnostics: `space.roomy.admin.push.getStats` (per-transport
`transportsConfigured`, plus lifetime counters) and
`space.roomy.admin.push.testSend` (per-endpoint delivery result, and the path that
prunes on `gone`).

---

## 7. Decisions

1. **Fork location:** `muni-town/tauri-plugin-mobile-push`, consumed via `git` +
   `rev` (§2). Work lands on a personal fork first and is pushed to the org fork
   by hand; the `rev` pin is what makes moving the dependency on that boundary a
   one-line change.
2. **Android fix ownership:** fixed in the fork (the upstream route), not by
   moving the token path into this repo. The fork was required either way.
3. **npm fork:** not needed — the JS surface is unchanged (§2).
4. **Upstream the fixes?** Still open. They are general, not Roomy-specific, so
   offering them back to `yanqianglu/tauri-plugin-mobile-push` and dropping the
   fork is reasonable; the `rev` pin makes that a one-line change.
5. **macOS APNs:** **in scope** (2026-10-09) — staged into four parts, §4. Stages
   0-2 (fork implementation, client, app wiring) are verifiable from a Linux
   checkout; §4.6 is Apple account work. Desktop has no push at all today,
   including the Web Push fallback (gate 2). This supersedes the earlier
   "decided against", which was made before the fork prototype was cross-checked.
