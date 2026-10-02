//! iOS entry points called by `ios/Sources/MobilePushPlugin.swift`.
//!
//! Symmetric to the JNI bridge in `commands.rs`: the Swift side reaches into
//! Rust rather than through Tauri's plugin dispatch, because this plugin
//! bypasses that dispatch on iOS (see the note at the top of `commands.rs`).

use std::ffi::CStr;
use std::os::raw::c_char;

/// Emits an event to the JS listeners registered for it.
///
/// Called from Swift through `@_silgen_name("mobile_push_emit_event")`. Both
/// strings are NUL-terminated UTF-8; a null or non-UTF-8 pointer is ignored,
/// since a panic here would cross the FFI boundary.
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn mobile_push_emit_event(event: *const c_char, payload: *const c_char) {
    if event.is_null() || payload.is_null() {
        return;
    }
    // SAFETY: the Swift side passes NUL-terminated strings that outlive the
    // call, and checks them for null before calling.
    let (event, payload) = unsafe { (CStr::from_ptr(event), CStr::from_ptr(payload)) };
    let (Ok(event), Ok(payload)) = (event.to_str(), payload.to_str()) else {
        log::error!("[mobile-push] dropping a non-UTF-8 platform event");
        return;
    };

    // A tap can arrive before any JavaScript has run (the app was launched by
    // tapping the notification), so it is held for the first listener to
    // register. A received notification is not: the moment it describes has
    // passed by the time the next launch runs.
    let sticky = event == "notification-tapped";
    crate::events::emit(event, payload, sticky);
}
