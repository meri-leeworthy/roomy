import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { needsVoiceScopeConsent } from "./voice-scope.ts";
import { SCOPE_SETS } from "../scopes.ts";

/**
 * The decision behind the voice join button.
 *
 * Voice RPCs are deliberately outside `base` (see `scopes.ts`): requesting an
 * unregistered `rpc:` scope makes HappyView reject the whole grant and blocks
 * sign-in for everyone. A `base` session therefore cannot call the voice RPCs,
 * and this predicate is what the join button consents around.
 */
describe("needsVoiceScopeConsent", () => {
  test("true for the base tier, which carries no voice rpcs", () => {
    assert.equal(needsVoiceScopeConsent(SCOPE_SETS.base), true);
  });

  test("false once the voice tier is granted", () => {
    assert.equal(needsVoiceScopeConsent(SCOPE_SETS.voice), false);
  });

  test("true for a signed-out or unintrospected session", () => {
    assert.equal(needsVoiceScopeConsent(null), true);
    assert.equal(needsVoiceScopeConsent(""), true);
    assert.equal(needsVoiceScopeConsent("   "), true);
  });

  test("a partial grant is not enough", () => {
    assert.equal(
      needsVoiceScopeConsent("atproto rpc:space.roomy.voice.join?aud=*"),
      true,
    );
  });
});
