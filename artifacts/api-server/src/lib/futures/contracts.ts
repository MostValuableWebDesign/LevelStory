/**
 * Futures contract specifications are configurable simulation inputs, not
 * exchange-authoritative facts. Verify every value before any future provider
 * or broker integration is considered.
 */

export type SessionHours = {
  timeZone: string;
  start: string;
  end: string;
};

export type FuturesContractSpecification = {
  rootSymbol: string;
  fullContractSymbol: string;
  exchange: string;
  contractMonth: string;
  tickSize: number;
  dollarValuePerTick: number;
  pointValue: number;
  contractMultiplier: number;
  regularSessionHours: SessionHours;
  commissionPerContract: number;
  exchangeAndRegulatoryFeesPerContract: number;
  exchangeFeePerContract?: number;
  regulatoryFeePerContract?: number;
  clearingFeePerContract?: number;
  maximumSpreadTicks: number;
  minimumLiquidity: number;
  rolloverDate: string;
  configurable: true;
  verificationNote: string;
};

const VERIFICATION_NOTE =
  "Configurable simulation value — verify before any future broker integration.";

export const FUTURES_CONTRACT_SPECS: Readonly<Record<string, FuturesContractSpecification>> = {
  MES: {
    rootSymbol: "MES",
    fullContractSymbol: "MESU26",
    exchange: "CME",
    contractMonth: "2026-09",
    tickSize: 0.25,
    dollarValuePerTick: 1.25,
    pointValue: 5,
    contractMultiplier: 1,
    regularSessionHours: { timeZone: "America/New_York", start: "09:30", end: "16:00" },
    commissionPerContract: 0.62,
    exchangeAndRegulatoryFeesPerContract: 0.18,
    exchangeFeePerContract: 0.12,
    regulatoryFeePerContract: 0.06,
    clearingFeePerContract: 0,
    maximumSpreadTicks: 2,
    minimumLiquidity: 2_000,
    rolloverDate: "2026-09-10",
    configurable: true,
    verificationNote: VERIFICATION_NOTE,
  },
  ES: {
    rootSymbol: "ES",
    fullContractSymbol: "ESU26",
    exchange: "CME",
    contractMonth: "2026-09",
    tickSize: 0.25,
    dollarValuePerTick: 12.5,
    pointValue: 50,
    contractMultiplier: 1,
    regularSessionHours: { timeZone: "America/New_York", start: "09:30", end: "16:00" },
    commissionPerContract: 1.24,
    exchangeAndRegulatoryFeesPerContract: 0.36,
    exchangeFeePerContract: 0.24,
    regulatoryFeePerContract: 0.12,
    clearingFeePerContract: 0,
    maximumSpreadTicks: 2,
    minimumLiquidity: 10_000,
    rolloverDate: "2026-09-10",
    configurable: true,
    verificationNote: VERIFICATION_NOTE,
  },
  MNQ: {
    rootSymbol: "MNQ",
    fullContractSymbol: "MNQU26",
    exchange: "CME",
    contractMonth: "2026-09",
    tickSize: 0.25,
    dollarValuePerTick: 0.5,
    pointValue: 2,
    contractMultiplier: 1,
    regularSessionHours: { timeZone: "America/New_York", start: "09:30", end: "16:00" },
    commissionPerContract: 0.62,
    exchangeAndRegulatoryFeesPerContract: 0.18,
    exchangeFeePerContract: 0.12,
    regulatoryFeePerContract: 0.06,
    clearingFeePerContract: 0,
    maximumSpreadTicks: 2,
    minimumLiquidity: 2_000,
    rolloverDate: "2026-09-10",
    configurable: true,
    verificationNote: VERIFICATION_NOTE,
  },
  NQ: {
    rootSymbol: "NQ",
    fullContractSymbol: "NQU26",
    exchange: "CME",
    contractMonth: "2026-09",
    tickSize: 0.25,
    dollarValuePerTick: 5,
    pointValue: 20,
    contractMultiplier: 1,
    regularSessionHours: { timeZone: "America/New_York", start: "09:30", end: "16:00" },
    commissionPerContract: 1.24,
    exchangeAndRegulatoryFeesPerContract: 0.36,
    exchangeFeePerContract: 0.24,
    regulatoryFeePerContract: 0.12,
    clearingFeePerContract: 0,
    maximumSpreadTicks: 2,
    minimumLiquidity: 10_000,
    rolloverDate: "2026-09-10",
    configurable: true,
    verificationNote: VERIFICATION_NOTE,
  },
};

function invalid(message: string): never {
  throw new Error(`Invalid futures contract configuration: ${message}`);
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) invalid(`${label} must be a finite positive number.`);
}

function positiveInteger(value: number, label: string): void {
  finitePositive(value, label);
  if (!Number.isInteger(value)) invalid(`${label} must be a positive integer.`);
}

function finiteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) invalid(`${label} must be a finite non-negative number.`);
}

function validTime(value: string, label: string): void {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid(`${label} must use HH:mm.`);
}

export function validateFuturesContractSpecification(
  specification: FuturesContractSpecification,
): FuturesContractSpecification {
  if (!specification || typeof specification !== "object") invalid("specification is required.");
  if (!/^[A-Z]{1,5}$/.test(specification.rootSymbol)) invalid("rootSymbol must be uppercase letters.");
  if (!specification.fullContractSymbol.startsWith(specification.rootSymbol)) {
    invalid("fullContractSymbol must begin with rootSymbol.");
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(specification.contractMonth)) {
    invalid("contractMonth must use YYYY-MM.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(specification.rolloverDate) || Number.isNaN(Date.parse(specification.rolloverDate))) {
    invalid("rolloverDate must be an ISO calendar date.");
  }
  if (!specification.exchange.trim()) invalid("exchange is required.");
  finitePositive(specification.tickSize, "tickSize");
  finitePositive(specification.dollarValuePerTick, "dollarValuePerTick");
  finitePositive(specification.pointValue, "pointValue");
  finitePositive(specification.contractMultiplier, "contractMultiplier");
  finiteNonNegative(specification.commissionPerContract, "commissionPerContract");
  finiteNonNegative(specification.exchangeAndRegulatoryFeesPerContract, "exchangeAndRegulatoryFeesPerContract");
  finiteNonNegative(specification.exchangeFeePerContract ?? specification.exchangeAndRegulatoryFeesPerContract, "exchangeFeePerContract");
  finiteNonNegative(specification.regulatoryFeePerContract ?? 0, "regulatoryFeePerContract");
  finiteNonNegative(specification.clearingFeePerContract ?? 0, "clearingFeePerContract");
  positiveInteger(specification.maximumSpreadTicks, "maximumSpreadTicks");
  finitePositive(specification.minimumLiquidity, "minimumLiquidity");
  validTime(specification.regularSessionHours.start, "regularSessionHours.start");
  validTime(specification.regularSessionHours.end, "regularSessionHours.end");
  if (specification.regularSessionHours.timeZone !== "America/New_York") {
    invalid("regularSessionHours.timeZone must be America/New_York.");
  }
  if (specification.regularSessionHours.start === specification.regularSessionHours.end) {
    invalid("regular session cannot have equal start and end.");
  }
  const derivedTickValue =
    specification.pointValue * specification.tickSize * specification.contractMultiplier;
  if (Math.abs(derivedTickValue - specification.dollarValuePerTick) > 1e-8) {
    invalid("dollarValuePerTick must equal pointValue × tickSize × contractMultiplier.");
  }
  if (specification.configurable !== true) invalid("all Phase 1 values must be labeled configurable.");
  if (!specification.verificationNote.toLowerCase().includes("verify")) {
    invalid("verificationNote must instruct verification.");
  }
  return { ...specification, regularSessionHours: { ...specification.regularSessionHours } };
}

const VALIDATED_SPECS = Object.freeze(
  Object.fromEntries(
    Object.entries(FUTURES_CONTRACT_SPECS).map(([key, value]) => [
      key,
      Object.freeze(validateFuturesContractSpecification(value)),
    ]),
  ) as Record<string, FuturesContractSpecification>,
);

export function listFuturesContractSpecifications(): FuturesContractSpecification[] {
  return Object.values(VALIDATED_SPECS).map((specification) => ({
    ...specification,
    regularSessionHours: { ...specification.regularSessionHours },
  }));
}

export function getFuturesContractSpecification(symbol: string): FuturesContractSpecification {
  const normalized = symbol.trim().toUpperCase();
  const specification =
    VALIDATED_SPECS[normalized] ??
    Object.values(VALIDATED_SPECS).find((candidate) => candidate.fullContractSymbol === normalized);
  if (!specification) invalid(`unsupported futures symbol "${symbol}". Choose MES, ES, MNQ, or NQ.`);
  return {
    ...specification,
    regularSessionHours: { ...specification.regularSessionHours },
  };
}

export function priceToTicks(price: number, specification: FuturesContractSpecification): number {
  finiteNonNegative(price, "price");
  const ticks = price / specification.tickSize;
  const rounded = Math.round(ticks);
  if (Math.abs(ticks - rounded) > 1e-8) invalid("price must be aligned to the contract tick size.");
  return rounded;
}

export function roundToTick(
  price: number,
  specification: FuturesContractSpecification,
): number {
  if (!Number.isFinite(price)) invalid("price must be finite.");
  return Number((Math.round(price / specification.tickSize) * specification.tickSize).toFixed(10));
}

export function ticksBetween(
  firstPrice: number,
  secondPrice: number,
  specification: FuturesContractSpecification,
): number {
  if (!Number.isFinite(firstPrice) || !Number.isFinite(secondPrice)) invalid("prices must be finite.");
  const ticks = Math.abs(firstPrice - secondPrice) / specification.tickSize;
  const rounded = Math.round(ticks);
  if (Math.abs(ticks - rounded) > 1e-8) invalid("price difference must be aligned to the contract tick size.");
  return rounded;
}

export function dollarsForTicks(
  ticks: number,
  quantity: number,
  specification: FuturesContractSpecification,
): number {
  if (!Number.isInteger(ticks) || ticks < 0) invalid("ticks must be a non-negative integer.");
  if (!Number.isInteger(quantity) || quantity < 0) invalid("quantity must be a non-negative whole contract count.");
  return ticks * quantity * specification.dollarValuePerTick;
}

export function wholeContractQuantity(
  riskDollars: number,
  entryPrice: number,
  stopPrice: number,
  specification: FuturesContractSpecification,
): number {
  finitePositive(riskDollars, "riskDollars");
  const stopTicks = ticksBetween(entryPrice, stopPrice, specification);
  if (stopTicks <= 0) return 0;
  const riskPerContract = dollarsForTicks(stopTicks, 1, specification);
  return Math.max(0, Math.floor(riskDollars / riskPerContract));
}

export function notionalValue(
  price: number,
  quantity: number,
  specification: FuturesContractSpecification,
): number {
  if (!Number.isFinite(price) || price < 0) invalid("price must be finite and non-negative.");
  if (!Number.isInteger(quantity) || quantity < 0) invalid("quantity must be a non-negative whole contract count.");
  return price * quantity * specification.pointValue * specification.contractMultiplier;
}