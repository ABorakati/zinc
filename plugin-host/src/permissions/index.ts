// Public surface of the permission model. Handlers of every area use `requirePermission` (and `requireNetHost` for the net rule).
export { requirePermission, requireAnyPermission, hasPermission, matchNetHost, requireNetHost } from "./check";
export type { PermissionContext, NetHostMatch } from "./check";
export { KNOWN_CAPABILITIES, isKnownCapability, capabilityTier } from "./ids";
export type { RiskTier } from "./ids";
export { describePermissions, declaredPermissions, permissionTier, netHostTier, isPrivateHost, parseHostEntry, NET_PREFIX, requiredIds, optionalIds } from "./risk";
export type { PromptGroup, PromptItem, DeclaredPermissions } from "./risk";
export { GrantStore, permissionState, listPermissions } from "./store";
export type { PermissionState, GrantRecord } from "./store";
