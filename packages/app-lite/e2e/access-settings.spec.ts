/**
 * The user Access settings page is gated behind the `access-settings` feature
 * flag while progressive scope expansion is iterated on, and the Bluesky DMs
 * row carries a second flag (`bluesky-dms`) on top of that gate.
 *
 * Defends five things:
 *   - both halves of the page gate: flag on → the "Access" sidebar entry is
 *     present and the page renders its real body (from `getScopeSettings`);
 *     flag off → the sidebar entry is gone, and direct navigation to the route
 *     still lands on a gated notice rather than the capability UI.
 *   - the DM row's own gate: with `bluesky-dms` off the row is gone while the
 *     Semble row stays, so the two are independently controlled.
 *   - the page's central promise: capabilities are shown as plain-language
 *     switches, and no raw OAuth scope token appears on the default view.
 *     Every token in the ceiling is a `kind:value` string, so a `:` is the
 *     signal that one leaked.
 *   - the switch reads the user's saved grant rather than a constant: the spec
 *     serves three different `getScopeSettings` responses and the switches
 *     follow — including a saved UNION of every capability, which must light
 *     both switches rather than trade one for the other.
 *   - turning a switch on asks for consent first: the dialogue names the
 *     capability, and a refusal never leaves the page.
 *
 * The seed enables both flags globally (see `seed.ts`), so the flag-on cases
 * run against the real projection. A flag-off case rewrites the `getFlags`
 * response for the page — the same value the client predicate consumes — so the
 * test needs no admin allowlist and stays hermetic.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { APPSERVER_DID, APPSERVER_HTTP_ORIGIN, TEST_USER_DID } from "./fixtures.ts";
import { SCOPE_SETS, capabilityScope } from "../src/lib/scopes.ts";

/**
 * The tier scopes as the *browser* computes them — the comparison the page
 * actually makes.
 *
 * `scopes.ts` embeds `VITE_APPSERVER_DID`, which the stack launcher sets to the
 * hermetic appserver's DID. This spec process never gets that var and so builds
 * each tier against the production default instead. Substituting keeps a served
 * grant equal to the browser's, so a tier actually covers: without it the tier
 * silently misses its appserver-audience token and no switch ever reads on.
 */
const BROWSER_TIERS = {
  /** The foundation every session carries — covers neither capability. */
  base: SCOPE_SETS.base.replaceAll("did:web:api.roomy.space", APPSERVER_DID),
  semble: SCOPE_SETS.semble.replaceAll("did:web:api.roomy.space", APPSERVER_DID),
  withDms: SCOPE_SETS.withDms.replaceAll("did:web:api.roomy.space", APPSERVER_DID),
  /** `base` ∪ Semble ∪ DMs — the union both capability switches produce. */
  union: capabilityScope(["semble", "withDms"]).replaceAll(
    "did:web:api.roomy.space",
    APPSERVER_DID,
  ),
} as const;

/** Serve `getFlags` with `flag` removed, before navigation. */
async function withoutFlag(page: Page, flag: string): Promise<void> {
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags*`,
    async (route) => {
      // `route.fetch()` bypasses the base fixture's `X-Test-Did` injection, so
      // re-assert it here — the appserver's test-mode verifier reads that
      // header, and without it this 401s.
      const res = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
      const body = (await res.json()) as { flags?: string[] };
      const flags = (body.flags ?? []).filter((f) => f !== flag);
      await route.fulfill({ response: res, json: { flags } });
    },
  );
}

/**
 * Serve `getScopeSettings` with a chosen stored grant, before navigation.
 *
 * The real handler reads the seeded read-state DB, which carries no grant row,
 * so the page would render every switch off and the "follows the saved grant"
 * claim would go untested.
 */
async function withStoredGrant(page: Page, scope: string): Promise<void> {
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.auth.getScopeSettings*`,
    async (route) => {
      const res = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
      await route.fulfill({
        response: res,
        json: { scope, requestedScope: null },
      });
    },
  );
}

const SEMBLE_SWITCH = 'button[role="switch"][aria-labelledby="access-semble-name"]';
const DMS_SWITCH = 'button[role="switch"][aria-labelledby="access-withDms-name"]';

test.describe("access-settings flag", () => {
  test("flag on: the Access entry and page render", async ({ page }) => {
    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    const accessLink = page.locator('a[href="/user/settings/scopes"]');
    await expect(accessLink).toBeVisible();

    await accessLink.click();
    await expect(page).toHaveURL(/\/user\/settings\/scopes$/);
    // The page's own heading proves the real body rendered, not the gate.
    await expect(page.getByText("What Roomy can do")).toBeVisible();
    await expect(page.getByText("Access settings are not enabled")).toHaveCount(
      0,
    );
  });

  test("flag off: no Access entry, and direct navigation shows the gate", async ({
    page,
  }) => {
    await withoutFlag(page, "access-settings");

    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    // The sidebar entry is hidden while the flag is off.
    await expect(page.locator('a[href="/user/settings/scopes"]')).toHaveCount(0);

    // Direct navigation still reaches the route, and it shows the gate
    // rather than the capability rows.
    await page.goto("/user/settings/scopes");
    await expect(page.getByText("Access settings are not enabled")).toBeVisible();
    await expect(page.getByText("What Roomy can do")).toHaveCount(0);
  });

  test("capabilities are plain-language switches, with no scope token in view", async ({
    page,
  }) => {
    await withStoredGrant(page, BROWSER_TIERS.semble);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    // Each capability is a switch whose accessible name is its own label, so
    // the affordance carries the wording rather than the name in a sibling.
    // Two rows, because the seed enables both the page gate and the DM row's
    // own flag.
    await expect(page.getByRole("switch")).toHaveCount(2);
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The raw scope strings live behind the disclosure, not on the page. A
    // scope token is always `kind:value`, so any `:` in what the page shows is
    // a leak — a real grant is served above, so the string exists to be shown.
    await expect(page.locator("details[open]")).toHaveCount(0);
    await expect(page.locator("code:visible")).toHaveCount(0);
  });

  test("each switch follows the saved grant, not a constant", async ({ page }) => {
    await withStoredGrant(page, BROWSER_TIERS.withDms);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    // `withDms` carries the DM tier and not the Semble one, so the two
    // switches must disagree — the only shape that distinguishes reading the
    // real grant from hardcoding a state.
    await expect(page.locator(DMS_SWITCH)).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("a saved union grant lights every switch it covers", async ({ page }) => {
    // Enabling one capability must not displace another: the saved grant is the
    // union of everything the user turned on, so a grant carrying both Semble
    // and DMs shows both switches on. A model where each capability replaces
    // the others cannot render this — it would have to pick one.
    await withStoredGrant(page, BROWSER_TIERS.union);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator(DMS_SWITCH)).toHaveAttribute("aria-checked", "true");

    // No switch acts on another, so the page carries no copy claiming one does.
    await expect(page.getByText("also stops asking for")).toHaveCount(0);
    await expect(page.getByText("replaces your saved access")).toHaveCount(0);
  });

  test("the DM row is its own flag: off, it is gone and Semble stays", async ({
    page,
  }) => {
    // The page gate is on (the seed enables it); only the DM row's flag is off,
    // served by rewriting the same `getFlags` response the client predicate
    // reads. A saved union grant keeps both switches' state meaningful: the DM
    // switch is absent because the row is, not because its grant is missing.
    await withStoredGrant(page, BROWSER_TIERS.union);
    await withoutFlag(page, "bluesky-dms");

    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    await expect(page.locator(DMS_SWITCH)).toHaveCount(0);
    await expect(page.getByText("Bluesky direct messages")).toHaveCount(0);
    // The gate is per row: the other capability is untouched by it, still
    // rendering and still reading its own part of the grant.
    await expect(page.getByRole("switch")).toHaveCount(1);
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("turning a switch on asks for consent, and refusing never leaves", async ({
    page,
  }) => {
    // Base only: neither capability is saved, so both switches start off and
    // the click below is genuinely the enable path.
    await withStoredGrant(page, BROWSER_TIERS.base);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );

    const before = page.url();

    await page.locator(SEMBLE_SWITCH).click();
    // The switch alone is not the ask: the dialogue names the capability and
    // what granting it lets Roomy do, before any redirect.
    await expect(
      page.getByRole("dialog").getByText("Save to your Semble collection"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Refusing is the whole decision — no redirect, and the switch falls back
    // to the saved grant it was reading from.
    await expect(page).toHaveURL(before);
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // …and the page is not left wedged: the row is still offered.
    await page.locator(SEMBLE_SWITCH).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("accepting the dialogue closes it and proceeds with the switch", async ({
    page,
  }) => {
    await withStoredGrant(page, BROWSER_TIERS.base);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    const before = page.url();

    await page.locator(SEMBLE_SWITCH).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Grant permission" }).click();

    // What this run can observe: the dialogue settled, so the consent step is
    // behind rather than still blocking. What it cannot: the OAuth redirect
    // itself — an app-password (test-mode) session has no PDS authorize
    // endpoint and no token to re-issue, so `requestScopeExpansion` is a
    // deliberate no-op there (the same limit `semble-personal.spec.ts` states).
    // The redirect → consent → callback leg is covered by the scope-grant and
    // scope-guard unit suites, not here. For the same reason the switch does
    // not flip: nothing granted the capability, and the switch reads the saved
    // grant.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(before);
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
