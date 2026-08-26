export { SHADOW_MODE_LABEL } from "./shadow-execution.js";

export type UserInterfaceState =
  | "loading"
  | "empty"
  | "error"
  | "ready"
  | "shadow-mode";