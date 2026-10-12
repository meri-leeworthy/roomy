//! The one navigation policy that keeps the webview on the app.
//!
//! The frontend routes *link clicks* (`packages/app-lite/src/lib/link-routing.ts`).
//! This covers the navigations no link click produces — `window.location.assign`
//! from app code, a redirect, a page that starts loading before the frontend
//! handler exists. It is the shell-side backstop for the same rule, so the two
//! must agree: a URL the app owns stays; anything else leaves for the OS.
//!
//! The rule is a pure function so it can be tested without booting a webview.

/// Whether the webview may navigate to `url` in place.
///
/// * The app's own document origin — the SPA's own routing — may navigate.
///   On `tauri://localhost` (macOS/Linux) that covers every SvelteKit route;
///   in dev (`http://localhost:5180`) the dev server's own reloads stay put.
/// * A non-`http(s)` scheme (the custom protocol, `about:`, `blob:`,
///   `data:`, `mailto:`) is left alone: those are the webview's own document
///   loads or a scheme the opener plugin handles on its own.
/// * Any other `http(s)` origin is a page the app does not serve. It must not
///   replace the document — the webview has no chrome to return from it — so
///   the caller opens it in the OS browser instead.
///
/// `document_origin` is the origin of the document the webview is showing. A
/// document that has not committed a URL yet (nothing loaded, or `about:blank`)
/// has no origin to compare against; navigations are allowed until it does,
/// which is what lets the first page load.
pub fn allows_in_place_navigation(document_origin: &str, url: &str) -> bool {
    let Some(origin) = origin_of(url) else {
        // Not a URL we can attribute an origin to (about:blank, a malformed
        // href, an unparsable scheme): not a page this policy governs.
        return true;
    };
    if !origin.starts_with("http:") && !origin.starts_with("https:") {
        return true;
    }
    document_origin.is_empty() || origin == document_origin
}

/// The `scheme://host[:port]` origin of an absolute URL, or `None` when the
/// value is not one — including schemes whose origin is opaque (`mailto:`).
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

#[cfg(test)]
mod tests {
    use super::allows_in_place_navigation;

    const APP: &str = "tauri://localhost";
    const WEB_APP: &str = "https://roomy.space";

    #[test]
    fn the_apps_own_origin_may_navigate() {
        assert!(allows_in_place_navigation(APP, "tauri://localhost/"));
        assert!(allows_in_place_navigation(
            APP,
            "tauri://localhost/did:plc:abc/01ROOM"
        ));
        assert!(allows_in_place_navigation(
            WEB_APP,
            "https://roomy.space/join"
        ));
    }

    #[test]
    fn another_http_origin_must_leave() {
        assert!(!allows_in_place_navigation(APP, "https://example.com/"));
        // The appserver's XRPC origin: a different origin from a production
        // document, so it must not replace the app.
        assert!(!allows_in_place_navigation(
            WEB_APP,
            "https://api.roomy.space/xrpc/x"
        ));
        // A different port on the same host is a different origin.
        assert!(!allows_in_place_navigation(
            "http://localhost:5180",
            "http://localhost:8080/xrpc/x"
        ));
    }

    #[test]
    fn the_dev_server_may_navigate() {
        assert!(allows_in_place_navigation(
            "http://localhost:5180",
            "http://localhost:5180/some/route"
        ));
    }

    #[test]
    fn non_http_schemes_are_left_alone() {
        assert!(allows_in_place_navigation(APP, "about:blank"));
        assert!(allows_in_place_navigation(APP, "blob:tauri://localhost/1a2b"));
        assert!(allows_in_place_navigation(APP, "data:text/html,x"));
        assert!(allows_in_place_navigation(APP, "mailto:hi@roomy.space"));
    }

    #[test]
    fn a_document_without_an_origin_yet_allows_the_first_load() {
        assert!(allows_in_place_navigation("", "https://roomy.space/"));
        // But a non-http scheme is still not a document replacement.
        assert!(allows_in_place_navigation("", "about:blank"));
    }
}
