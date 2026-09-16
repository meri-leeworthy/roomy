import { describe, expect, test } from "vitest";
import { marked } from "marked";
// Importing this module registers the `marked` link renderer that decides
// which links are marked as internal space/room references. We then call
// `marked.parse` directly (no DOMPurify → no DOM requirement) and assert on
// the raw HTML.
import "./markdown";

/** Whether rendered HTML marks the single link as internal (badge-mountable). */
function isInternal(markdown: string): boolean {
	const html = marked.parse(markdown, { async: false, breaks: true }) as string;
	return html.includes('data-roomy-internal-link="true"');
}

describe("internal-link marking in the marked renderer", () => {
	// Only a real (DID, ULID?) pair on the path is an internal space/room
	// link. App routes (/watch, /profile, …), non-DID segments
	// (roomy.space/muni-town), and bare domain links must NOT be marked —
	// otherwise the badge prefetch fires 404 getSpaceSummary queries.

	test("marks valid relative space/room links", () => {
		expect(isInternal("[room](/did:plc:abc/01KZBRQMEP2FTE079YRVDFKGTA)")).toBe(true);
		expect(isInternal("[space](/did:plc:abc)")).toBe(true);
	});

	test("does not mark relative app routes", () => {
		expect(isInternal("[watch](/watch)")).toBe(false);
		expect(isInternal("[profile](/profile)")).toBe(false);
		expect(isInternal("[blog](/blog/essays)")).toBe(false);
	});

	test("marks valid bare roomy.space space/room links", () => {
		expect(isInternal("https://roomy.space/did:plc:abc/01KZBRQMEP2FTE079YRVDFKGTA")).toBe(true);
		expect(isInternal("https://a.roomy.space/did:plc:abc")).toBe(true);
	});

	test("does not mark bare roomy.space links to non-DID segments", () => {
		expect(isInternal("https://roomy.space/muni-town")).toBe(false);
		expect(isInternal("https://roomy.space/profile")).toBe(false);
		expect(isInternal("https://roomy.space/watch")).toBe(false);
	});

	test("does not mark bare roomy.space links with invalid room id", () => {
		expect(isInternal("https://roomy.space/did:plc:abc/not-a-ulid")).toBe(false);
	});
});
