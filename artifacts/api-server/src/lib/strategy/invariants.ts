import type { BreakoutEvent, OrbBreakoutState } from "./phase4.js";
import type { Phase6Decision, SetupEvaluation } from "./phase6.js";
import type { Phase7RiskPlan } from "./phase7.js";
import type { PatienceAnalysis } from "./phase5.js";

export type DashboardSignalInvariant = {
  key: "orb" | "pullback" | "patience" | "volume";
  status: "confirmed" | "watching" | "blocked";
};

export type DashboardInvariantInput = {
  ntz: { complete: boolean };
  breakout: Pick<BreakoutEvent, "detected" | "failed" | "state" | "volumeSupported" | "continuationConfirmed" | "direction">;
  signals: readonly DashboardSignalInvariant[];
  riskPlan: Pick<Phase7RiskPlan, "allowed" | "contracts" | "direction">;
  patience: Pick<PatienceAnalysis, "entryBufferPrice" | "strategyStopPrice">;
  setupAnalysis: {
    decision: Phase6Decision;
    primarySetup: SetupEvaluation["setupType"] | null;
    evaluations: readonly SetupEvaluation[];
  };
  shadowExecution: { contracts: number } | null;
};

export type DashboardInvariantViolation = {
  code:
    | "ORB_SIGNAL_WITHOUT_QUALIFIED_BREAKOUT"
    | "RISK_APPROVAL_CONTRADICTION"
    | "SETUP_DIRECTION_CONTRADICTION"
    | "QUALIFIED_SETUP_WITHOUT_PATIENCE_ENTRY"
    | "SHADOW_EXECUTION_WHILE_BLOCKED";
  detail: string;
};

const confirmedBreakoutStates = new Set<OrbBreakoutState>([
  "QUALIFIED_BREAKOUT",
  "WAITING_FOR_PULLBACK",
  "PULLBACK_IN_PROGRESS",
  "WAITING_FOR_PATIENCE_CANDLE",
  "PATIENCE_CANDLE_VALID",
  "TRIGGER_CANDLE_ACTIVE",
  "ENTRY_TRIGGERED",
]);

export function validateDashboardInvariants(input: DashboardInvariantInput): DashboardInvariantViolation[] {
  const violations: DashboardInvariantViolation[] = [];
  const orbSignal = input.signals.find((signal) => signal.key === "orb");
  const selected = input.setupAnalysis.primarySetup === null
    ? input.setupAnalysis.evaluations[0]
    : input.setupAnalysis.evaluations.find((evaluation) => evaluation.setupType === input.setupAnalysis.primarySetup);
  const executableSetup = selected?.decision === "SETUP QUALIFIED" && !selected.alertOnly;
  const riskApproval = selected?.rules.find((rule) => rule.key === "riskApproval");

  if (orbSignal?.status === "confirmed" && (
    !input.ntz.complete
    || !input.breakout.detected
    || input.breakout.failed
    || !confirmedBreakoutStates.has(input.breakout.state)
  )) {
    violations.push({
      code: "ORB_SIGNAL_WITHOUT_QUALIFIED_BREAKOUT",
      detail: "The ORB signal is confirmed without a finalized, quality-qualified breakout.",
    });
  }

  if (!input.riskPlan.allowed && riskApproval?.passed === true) {
    violations.push({
      code: "RISK_APPROVAL_CONTRADICTION",
      detail: "The risk plan is blocked while the selected phased setup still passes risk approval.",
    });
  }

  if (executableSetup && selected.direction !== input.riskPlan.direction) {
    violations.push({
      code: "SETUP_DIRECTION_CONTRADICTION",
      detail: `The qualified setup direction (${selected.direction ?? "none"}) does not match the risk-plan direction (${input.riskPlan.direction ?? "none"}).`,
    });
  }

  if (executableSetup && (input.patience.entryBufferPrice === null || input.patience.strategyStopPrice === null)) {
    violations.push({
      code: "QUALIFIED_SETUP_WITHOUT_PATIENCE_ENTRY",
      detail: "The setup is qualified even though the phased patience analysis has no buffered entry and strategy stop.",
    });
  }

  if (input.shadowExecution && (!executableSetup || !input.riskPlan.allowed || input.riskPlan.contracts <= 0 || input.shadowExecution.contracts <= 0)) {
    violations.push({
      code: "SHADOW_EXECUTION_WHILE_BLOCKED",
      detail: "Shadow execution exists while setup qualification, risk approval, or contract sizing is blocked.",
    });
  }

  return violations;
}

export function assertDashboardInvariants(input: DashboardInvariantInput): void {
  const violations = validateDashboardInvariants(input);
  const blockingViolations = violations.filter((violation) => violation.code !== "ORB_SIGNAL_WITHOUT_QUALIFIED_BREAKOUT");
  if (blockingViolations.length) {
    throw new Error(`Dashboard strategy invariant violation: ${blockingViolations.map((violation) => `${violation.code}: ${violation.detail}`).join(" ")}`);
  }
}
