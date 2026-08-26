import assert from "node:assert/strict";
import test from "node:test";
import { COCKPIT_PREVIEW_STATES, getCockpitPreview, isDecisionPreviewState, isFeedPreviewState } from "../src/lib/cockpit-state.ts";

test("exposes every Phase 10 feed and decision state for display review", () => {
  const values = COCKPIT_PREVIEW_STATES.map((item) => item.value);
  assert.deepEqual(values, [
    "live",
    "loading",
    "market_closed",
    "empty",
    "stale",
    "disconnected",
    "error",
    "no_trade",
    "setup_forming",
    "qualified",
    "active_shadow_trade",
    "runner_active",
    "risk_lockout",
    "ambiguous",
  ]);
  assert.equal(new Set(values).size, values.length);
});

test("keeps feed and decision previews distinct", () => {
  assert.equal(isFeedPreviewState("stale"), true);
  assert.equal(isFeedPreviewState("qualified"), false);
  assert.equal(isDecisionPreviewState("qualified"), true);
  assert.equal(isDecisionPreviewState("disconnected"), false);
});

test("unknown preview values fail safe to the calculated baseline", () => {
  assert.equal(getCockpitPreview("made-up-state").value, "live");
  assert.equal(getCockpitPreview("risk_lockout").description.includes("Shadow Mode"), false);
  assert.equal(getCockpitPreview("active_shadow_trade").description.includes("No broker"), true);
});