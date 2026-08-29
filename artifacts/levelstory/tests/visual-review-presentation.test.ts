import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/visual-review.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const chart = readFileSync(new URL("../src/lib/visual-review-chart.ts", import.meta.url), "utf8");

test("visual review presentation keeps the inspector and event strip outside the plot", () => {
  assert.match(page, /<section className=\{`candle-inspector/);
  assert.ok(page.includes("inspector-meta"));
  assert.match(page, /data-testid="toggle-candle-inspector"/);
  assert.match(page, /No historical candle available/);
  assert.match(page, /selected .* final/);
  assert.match(page, /hover or arrow-key selection/);
  assert.match(page, /data-testid="event-strip"/);
  assert.ok(page.indexOf('data-testid="event-strip"') < page.indexOf('className="visual-review-svg'));
  assert.match(styles, /\.candle-inspector \{/);
});

test("visual review presentation uses the full-session default and compact causal boundary", () => {
  assert.match(page, /return "full_regular";/);
  assert.match(page, /levelstory\.visualReviewWindow/);
  assert.match(page, /Full regular session: 9:30 AM–4:00 PM/);
  assert.doesNotMatch(page, /Machine evaluated through/);
  assert.match(page, /data-testid="causal-boundary-notch"/);
  assert.doesNotMatch(page, /data-testid="evaluation-cursor"/);
  assert.doesNotMatch(page, /data-testid="human-only-label"/);
  assert.doesNotMatch(page, /chart-level-connector-/);
});

test("visual review presentation retains human-only shading and semantic level colors", () => {
  assert.match(page, /data-testid="human-only-region"/);
  assert.ok(chart.includes("label: `ORB / NTZ ${side}`"));
  assert.match(page, /stroke="hsl\(5 58% 46%\)"/);
  assert.match(page, /stroke="hsl\(145 45% 42%\)"/);
  assert.match(page, /data-testid="toggle-show-risk-levels"/);
  assert.match(page, /data-testid="no-entry-marker"/);
  assert.doesNotMatch(page, /OPENING RANGE/);
  assert.match(page, /data-testid="compact-coverage-details"/);
  assert.match(page, /data-testid="review-period"/);
  assert.match(page, /SnapshotHeaderContent/);
  assert.match(page, /data-testid="formula-development-sample"/);
  assert.match(page, /Example \{String\(index \+ 1\)\.padStart\(2, "0"\)/);
  assert.match(page, /reviewPeriod\.startDate/);
  assert.match(page, /reviewPeriod\.endDate/);
  assert.match(page, /confirmed_signals/);
  assert.doesNotMatch(page, /data-testid="category-coverage-summary"/);
  assert.doesNotMatch(page, /SetManifest/);
  assert.doesNotMatch(page, /Stated category/);
  assert.match(page, /previous-session-high/);
  assert.match(page, /two-sessions-high/);
  assert.match(page, /pointerEvents="none"/);
});

test("visual review keeps no-entry diagnostics collapsed behind an explicit mode", () => {
  assert.match(page, /trades_only/);
  assert.match(page, /trades_and_diagnostics/);
  assert.match(page, /data-testid="diagnostic-categories"/);
  assert.match(page, /No-entry diagnostics/);
});

test("human judgment teaches only from an explicitly locked causal candle pair", () => {
  for (const label of ["Correct", "Incorrect", "Uncertain", "Rule needs clarification", "Missed trade", "False-positive trade"]) {
    assert.ok(page.includes(`label: "${label}"`) || page.includes(`>${label}<`) || page.includes(`>${label}`), `missing ${label}`);
  }
  assert.match(page, /data-testid="button-lock-entry-candle"/);
  assert.match(page, /data-testid="locked-entry-marker"/);
  assert.match(page, /Selected entry candle E/);
  assert.match(page, /onLockCandle\(selectedCandle\)/);
  assert.match(page, /data-testid="locked-entry-candle"/);
  assert.match(page, /data-testid="locked-patience-candle"/);
  assert.match(page, /immediately preceding/);
  assert.match(page, /Selecting an option only creates a draft/);
  assert.match(page, /beforeunload/);
  assert.match(page, /data-testid="calculated-mes-entry"/);
  assert.match(page, /Qualifying pullback level/);
  assert.match(page, /availableLevels\.map/);
  assert.match(page, /Unable to save this review/);
  assert.match(page, /Human judgments never mutate executable formula behavior/);
});