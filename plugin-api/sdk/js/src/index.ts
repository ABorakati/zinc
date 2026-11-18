// @zinc/plugin-sdk: JS SDK for Zinc WASM plugins.
//   definePlugin, fail        plugin.ts   exports with defaults
//   ui.*                      ui.ts       UI tree builders (nested JSON form), toTree(), dialog specs
//   fill, u32, rgba ...       defaults.ts defaults for required record fields; the u32 (>= 2^31) workaround
//   defineTool, registerTools, mcpManifest   mcp.ts   tools for AI agents (definePlugin({ tools }))
//   ext.*                     ext.ts      registration helpers (menus, columns, sections, settings, reader listeners)
// The types of the imports come from sdk/js/types (generated from the WIT: `bun scripts/gen-types.ts`).
export { definePlugin, fail } from "./plugin";
export type { PluginImpl, FullPlugin } from "./plugin";
export * as ui from "./ui";
export * as ext from "./ext";
export { defineTool, registerTools, mcpManifest, toolDef } from "./mcp";
export type { Tool, ToolSpec, ToolHandler, JsonSchema } from "./mcp";
export { fill, u32, rgba, hexColor, themedColor } from "./defaults";
