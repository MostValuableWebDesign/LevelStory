/**
 * Shadow execution is deliberately a capability boundary, not an execution
 * API. It describes what the product is allowed to do without creating an
 * order-placement function or a provider connection.
 */
export const SHADOW_MODE_LABEL = "SHADOW MODE — NO LIVE ORDERS";

export type ShadowModeCapabilities = {
  simulatedMarketData: true;
  journalMutations: true;
  brokerAuthentication: false;
  liveOrders: false;
  paperBrokerOrders: false;
};

export const SHADOW_MODE_CAPABILITIES: Readonly<ShadowModeCapabilities> = Object.freeze({
  simulatedMarketData: true,
  journalMutations: true,
  brokerAuthentication: false,
  liveOrders: false,
  paperBrokerOrders: false,
});

export function assertShadowMode(): ShadowModeCapabilities {
  return { ...SHADOW_MODE_CAPABILITIES };
}