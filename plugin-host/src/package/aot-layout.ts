// Where a plugin's AOT executable lives, relative to the plugin folder (manifest.ts). Kept apart from aot.ts so worker.ts stays light.
export const AOT_EXE = process.platform === "win32" ? "aot/plugin.exe" : "aot/plugin";
