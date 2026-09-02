import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveTeachingCompatibilityFields, evaluateDynamicLevelInteraction } from "../src/lib/visual-review-teaching.ts";

const page = readFileSync(new URL("../src/pages/visual-review.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const chart = readFileSync(new URL("../src/lib/visual-review-chart.ts", import.meta.url), "utf8");

test("visual review presentation keeps the inspector and event strip outside the plot", () => {
  assert.match(page, /<section className=\{`candle-inspector/);
  assert.ok(page.includes("inspector-meta"));
  assert.match(page, /data-testid="toggle-candle-inspector"/);
  assert.match(page, /No historical candle available/);
  assert.doesNotMatch(page, /Exact raw OHLCV/);
  assert.doesNotMatch(page, /selected .* final/);
  assert.doesNotMatch(page, /Events:<\/span>/);
  assert.match(page, /hover or arrow-key selection/);
  assert.match(page, /data-testid="event-strip"/);
  assert.ok(page.indexOf('data-testid="event-strip"') < page.indexOf('className="visual-review-svg'));
  assert.match(styles, /\.candle-inspector \{/);
});

test("visual review presentation uses the full-session default and compact causal boundary", () => {
  assert.match(page, /return "full_regular";/);
  assert.match(page, /levelstory\.visualReviewWindow/);
  assert.match(page, /Primary window: 9:30 AM–1:00 PM/);
  assert.match(page, /Full regular session: 9:30 AM–4:00 PM/);
  assert.doesNotMatch(page, /Machine evaluated through/);
  assert.match(page, /data-testid="causal-boundary-notch"/);
  assert.doesNotMatch(page, /data-testid="evaluation-cursor"/);
  assert.doesNotMatch(page, /data-testid="human-only-label"/);
  assert.doesNotMatch(page, /chart-level-connector-/);
});

test("visual review browses one stable queue across dates and categories", () => {
  assert.match(page, /const reviewQueue = strategySnapshots/);
  assert.match(page, /selectedSnapshotIndex=\{reviewQueue\.findIndex/);
  assert.match(page, /selectedSnapshotTotal=\{reviewQueue\.length\}/);
  assert.match(page, /moveSnapshot\(reviewQueue, activeSnapshot/);
  assert.match(page, /<SnapshotNavigator snapshots=\{reviewQueue\}/);
  assert.match(page, /setSelectedCategory\(snapshot\.category\)/);
  assert.match(page, /snapshot\.tradingDate/);
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
  assert.match(page, /data-testid="chart-level-legend"/);
  assert.match(page, /formatPriceAxisValue\(annotation\.price!\)/);
  assert.doesNotMatch(page, /labelYById/);
  assert.doesNotMatch(page, /axisLabelX/);
  assert.doesNotMatch(page, /data-testid="additional-levels".*fib-/s);
  assert.match(page, /SnapshotHeaderContent/);
  assert.match(page, /data-testid="formula-development-sample"/);
  assert.match(page, /Example \{String\(index \+ 1\)\.padStart\(2, "0"\)/);
  assert.match(page, /reviewPeriod\.startDate/);
  assert.match(page, /reviewPeriod\.endDate/);
  assert.match(page, /Generate trade candidates/);
  assert.match(page, /Coverage \/ Trade Candidates/);
  assert.match(page, /button-trade-candidate/);
  assert.doesNotMatch(page, /data-testid="category-coverage-summary"/);
  assert.doesNotMatch(page, /SetManifest/);
  assert.doesNotMatch(page, /Stated category/);
  assert.match(page, /previous-session-high/);
  assert.match(page, /two-sessions-high/);
  assert.match(page, /pointerEvents="none"/);
   assert.match(page, /indicator-curve-vwap/);
   assert.match(page, /indicator-curve-ema200/);
   assert.match(page, /activeIndicatorId/);
   assert.match(page, /8 MES ticks · 2\.00 points/);
   assert.doesNotMatch(page, /Critical · Premarket high/);
   assert.doesNotMatch(page, /Critical · Premarket low/);
   assert.match(page, /data-testid="trade-lifetime-overlay"/);
   assert.match(page, /data-testid="trade-inspector"/);
   assert.match(page, /TARGET EXIT/);
   assert.match(page, /RUNNER EXIT/);
   assert.match(page, /trade-leg-label-/);
   assert.match(page, /Open \/ unscored/);
   assert.match(page, /data-testid="trade-leg-inspector"/);
});

test("visual review exposes only confirmed trade candidates", () => {
  assert.match(page, /trades_only/);
  assert.doesNotMatch(page, /data-testid="diagnostic-categories"/);
  assert.doesNotMatch(page, /No-entry diagnostics/);
  assert.doesNotMatch(page, /Bullish patience candle/);
  assert.doesNotMatch(page, /Bearish patience candle/);
  assert.doesNotMatch(page, /Weak ORB probe/);
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
  assert.match(page, /configured \{levelToleranceTicks\}-tick MES proximity zone/);
  assert.match(page, /Outside \{levelToleranceTicks\}-tick zone/);
  assert.doesNotMatch(page, /Only levels contained by the selected patience candle/);
  assert.match(page, /Unable to save this review/);
  assert.match(page, /Human judgments never mutate executable formula behavior/);
});

test("teaching compatibility fields exclude dynamic indicators and clear stale singleton fields", () => {
  const dynamic = {
    levelId: "vwap",
    levelType: "dynamic_indicator" as const,
    valueAtInteraction: 6851.508,
    sourceTimestamp: "2026-08-26T13:30:00.000Z",
    rangeLow: null,
    rangeHigh: null,
  };
  const fixed = {
    levelId: "orb-high",
    levelType: "fixed_level" as const,
    valueAtInteraction: 6849.75,
    sourceTimestamp: "2026-08-26T13:30:00.000Z",
    rangeLow: null,
    rangeHigh: null,
  };
  assert.deepEqual(deriveTeachingCompatibilityFields([dynamic, fixed]), {
    pullbackLevels: [6849.75],
    qualifyingLevelId: "orb-high",
    qualifyingLevelRangeLow: null,
    qualifyingLevelRangeHigh: null,
  });
  assert.deepEqual(deriveTeachingCompatibilityFields([dynamic]), {
    pullbackLevels: [],
    qualifyingLevelId: undefined,
    qualifyingLevelRangeLow: null,
    qualifyingLevelRangeHigh: null,
  });
  assert.match(page, /qualifyingLevels: normalizeTeachingQualifyingLevels/);
});

test("frontend dynamic-level interaction matches the configured L-range rule", () => {
  const cases = [
    { name: "wick touches fractional VWAP", high: 6851.508, low: 6850, value: 6851.508, qualifies: true, distanceTicks: 0 },
    { name: "body crosses fractional VWAP", high: 6852, low: 6851, value: 6851.508, qualifies: true, distanceTicks: 0 },
    { name: "closes below after touching", high: 6851.508, low: 6850.5, value: 6851.508, qualifies: true, distanceTicks: 0 },
    { name: "stays within four ticks", high: 6850.5, low: 6849, value: 6851.492, qualifies: true, distanceTicks: 4 },
    { name: "exceeds four ticks", high: 6850.25, low: 6849, value: 6851.492, qualifies: false, distanceTicks: 5 },
  ];
  for (const example of cases) {
    const result = evaluateDynamicLevelInteraction(example.value, example.high, example.low, 4);
    assert.equal(result.qualifies, example.qualifies, example.name);
    assert.equal(result.distanceTicks, example.distanceTicks, example.name);
  }
  assert.equal(evaluateDynamicLevelInteraction(6851.508, 6851, 6850, 4).value, 6851.508);
  assert.equal(evaluateDynamicLevelInteraction(6851.492, 6851, 6850, 4).value, 6851.492);
});