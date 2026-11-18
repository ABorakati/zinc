// @zinc/plugin-sdk: JS SDK for Zinc WASM plugins.
//   definePlugin, fail        plugin.ts   exports with defaults
//   ui.*                      ui.ts       UI tree builders (nested JSON form), toTree(), dialog specs
//   fill, u32, rgba ...       defaults.ts defaults for required record fields; the u32 (>= 2^31) workaround
//   ext.*                     ext.ts      registration helpers (menus, columns, sections, settings, reader listeners)
// The types of the imports come from sdk/js/types (generated from the WIT: `bun scripts/gen-types.ts`).
export { definePlugin, fail } from "./plugin";
export type { PluginImpl, FullPlugin } from "./plugin";
export * as ui from "./ui";
export * as ext from "./ext";
export { fill, u32, rgba, hexColor, themedColor } from "./defaults";
