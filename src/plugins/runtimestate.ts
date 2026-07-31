import type { RealtimeDocument } from "../realtime/ddata-snapshot";

/**
 * Request-local port of locked plugins/runtimestate.setProperties(). A Worker
 * request is dispatched only after module initialization, so the platform
 * status surface supplies the same ordinary steady-state value, `loaded`.
 */
export function calculateRuntimeStateProperty(
  runtimeState: unknown = "loaded",
): RealtimeDocument {
  return { state: runtimeState };
}
