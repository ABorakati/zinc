// Public surface of the plugin host package.
export { createPluginSupervisor } from "./supervisor";
export type { PluginSupervisor, SupervisorOptions, SupervisorEvents, PluginInfo, PluginStatus, PluginRunner, LoadInfo } from "./supervisor";
export { resolveZhwPath, encodeWire, decodeWire } from "./transport-wasmtime";
export { PluginError, DEFAULT_TIMEOUTS } from "./protocol";
export type { WireError, WireResult, LogLevel } from "./protocol";
export { defineHandler, witError, WitError, discoverHandlers, loadHandlerModule } from "./imports/registry";
export type { ImportHandler, HandlerContext, HandlerFn } from "./imports/registry";
export { readManifest, declaredGrants } from "./manifest";
export type { Grants, PluginManifest } from "./manifest";
// Packages, permissions, prefs, secrets, l10n and the runtime that wires them to a supervisor.
export * from "./package/index";
// The data area's hooks (file picker, clipboard, shell, fs roots) and the pieces the app wires.
export { setFilePicker } from "./imports/data/pick-hook";
export { setClipboardBackend, setShellBackend } from "./imports/data/os-hooks";
export { configureFs, clearTempRoot, addGrant } from "./imports/data/fs-roots";
