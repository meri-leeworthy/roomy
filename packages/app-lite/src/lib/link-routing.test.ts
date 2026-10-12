/**
 * Tests for the link-routing decision: shell vs web, internal vs external, and
 * the targets that must stay in the document.
 *
 * Run with the package's Node test runner (`node --test`); the module is pure
 * (no DOM, no build env) so no browser stub is needed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { routeLinkClick, type LinkClick } from "./link-routing.ts";

const DOC_ORIGIN = "https://roomy.space";
const DOC_URL = "https://roomy.space/did:plc:abc/01ROOM";
const INTERNAL = ["https://roomy.space", "https://api.roomy.space"];
const SPACE = "did:plc:gnwy2zbm3hu4gfdawzxmpb2s";
const ROOM = "01M2EQKCWRQ2M0BTNK5SD8864S";

function click(overrides: Partial<LinkClick> = {}): LinkClick {
  return {
    href: "https://example.com/",
    download: false,
    modifierClick: false,
    isShell: true,
    documentOrigin: DOC_ORIGIN,
    documentUrl: DOC_URL,
    internalOrigins: INTERNAL,
    ...overrides,
  };
}

describe("routeLinkClick — external links in the shell", () => {
  test("an off-origin https link leaves the webview", () => {
    assert.deepEqual(routeLinkClick(click({ href: "https://example.com/post" })), {
      kind: "external",
      url: "https://example.com/post",
    });
  });

  test("a mailto: link hands off to the mail client", () => {
    assert.deepEqual(routeLinkClick(click({ href: "mailto:hi@roomy.space" })), {
      kind: "external",
      url: "mailto:hi@roomy.space",
    });
  });

  test("a tel: link hands off to the dialer", () => {
    assert.deepEqual(routeLinkClick(click({ href: "tel:+15555550123" })), {
      kind: "external",
      url: "tel:+15555550123",
    });
  });

  test("a link to the appservers web origin (an absolute internal link) leaves", () => {
    // The appserver origin serves XRPC, not the SPA: navigating there in place
    // would take the webview off the app.
    assert.deepEqual(
      routeLinkClick(click({ href: "https://api.roomy.space/xrpc/foo" })),
      { kind: "external", url: "https://api.roomy.space/xrpc/foo" },
    );
  });
});

describe("routeLinkClick — internal links navigate in-app", () => {
  test("a relative space link resolves to its in-app path", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: `https://roomy.space/${SPACE}` })),
      { kind: "internal", path: `/${SPACE}` },
    );
  });

  test("a space+room link keeps the room segment", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: `https://roomy.space/${SPACE}/${ROOM}` })),
      { kind: "internal", path: `/${SPACE}/${ROOM}` },
    );
  });

  test("an absolute link rooted at the appservers origin is still in-app", () => {
    // The SpaceRoomBadge path renders this form; it must not become a
    // cross-origin navigation just because production serves the app at
    // roomy.space while the appserver is api.roomy.space.
    assert.deepEqual(
      routeLinkClick(click({ href: `https://api.roomy.space/${SPACE}/${ROOM}` })),
      { kind: "internal", path: `/${SPACE}/${ROOM}` },
    );
  });

  test("a space link on the app's own origin is in-app", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: `https://roomy.space/${SPACE}` })),
      { kind: "internal", path: `/${SPACE}` },
    );
  });

  test("an in-app route on the app origin is left to SvelteKit", () => {
    assert.deepEqual(routeLinkClick(click({ href: "https://roomy.space/join" })), {
      kind: "default",
    });
  });

  test("a DID under /user is an app route, not a space", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: `https://roomy.space/user/${SPACE}` })),
      { kind: "default" },
    );
  });
});

describe("routeLinkClick — the web build is untouched", () => {
  test("an off-origin link is left to the browser", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: "https://example.com/", isShell: false })),
      { kind: "default" },
    );
  });

  test("mailto: is left to the browser", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: "mailto:hi@roomy.space", isShell: false })),
      { kind: "default" },
    );
  });

  test("internal space links still resolve in-app", () => {
    assert.deepEqual(
      routeLinkClick(
        click({ href: `https://api.roomy.space/${SPACE}`, isShell: false }),
      ),
      { kind: "internal", path: `/${SPACE}` },
    );
  });
});

describe("routeLinkClick — targets that stay in the document", () => {
  test("a download anchor is a save, not an open", () => {
    assert.deepEqual(
      routeLinkClick(
        click({ href: "https://cdn.example.com/clip.mp4", download: true }),
      ),
      { kind: "default" },
    );
  });

  test("a modifier click keeps its platform meaning", () => {
    assert.deepEqual(
      routeLinkClick(
        click({ href: "https://example.com/", modifierClick: true }),
      ),
      { kind: "default" },
    );
  });

  test("a blob: media target is not a page to leave for", () => {
    assert.deepEqual(
      routeLinkClick(click({ href: "blob:https://roomy.space/9f8e-7d6c" })),
      { kind: "default" },
    );
  });

  test("an in-page fragment is document state", () => {
    assert.deepEqual(routeLinkClick(click({ href: `${DOC_URL}#reply-3` })), {
      kind: "default",
    });
  });

  test("a hash route elsewhere on the app origin is left to the router", () => {
    assert.deepEqual(routeLinkClick(click({ href: "https://roomy.space/#/home" })), {
      kind: "default",
    });
  });

  test("an unparseable href is left alone", () => {
    assert.deepEqual(routeLinkClick(click({ href: "javascript:void(0)" })), {
      kind: "default",
    });
  });
});
