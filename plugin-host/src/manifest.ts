// The loadable plugin folder produced by scripts/build-plugin.ts (and, later, by the installer):
//
//   <dir>/manifest.json        the plugin manifest (plugin-api/manifest.schema.json), main.wasm = "plugin.wasm"
//   <dir>/plugin.wasm          the component (`zhw` compiles it, or loads the precompiled `.cwasm` from Zinc's cache)
import { join } from "node:path";

export interface Grants {
	/** Permission ids the plugin may use (manifest `permissions.capabilities`, minus what the user denied). */
	capabilities: string[];
	/** Allowed network hosts (manifest `permissions.net.hosts`). */
	netHosts: string[];
}

/** The parts of manifest.json the host reads. The full file is passed through to handlers as `ctx.manifest`. */
/** The worlds of `zinc:plugin` (plugin-api/wit/world.wit) a component may target. */
export type PluginWorld = "plugin" | "plugin-minimal" | "plugin-core" | "plugin-library" | "plugin-extend" | "plugin-ui" | "plugin-reader" | "plugin-dialogs" | "plugin-mcp";

export interface PluginManifest {
	manifest_version: number;
	id: string;
	name: string;
	version: string;
	main: { wasm: string; world?: PluginWorld; language?: string; sha256?: string; startup_timeout_ms?: number };
	permissions?: { capabilities?: string[]; net?: { hosts?: string[] } };
	default_prefs?: Record<string, boolean | number | string>;
	[key: string]: unknown;
}

export async function readManifest(pkgDir: string): Promise<PluginManifest> {
	const file = Bun.file(join(pkgDir, "manifest.json"));
	if (!(await file.exists())) throw new Error(`no manifest.json in ${pkgDir}`);
	const m = (await file.json()) as PluginManifest;
	if (typeof m.id !== "string" || typeof m.version !== "string" || typeof m.main?.wasm !== "string") {
		throw new Error(`${pkgDir}/manifest.json: id, version and main.wasm are required`);
	}
	return m;
}

/** What the manifest declares. A later step replaces this with what the user granted. */
export function declaredGrants(m: PluginManifest): Grants {
	return {
		capabilities: [...(m.permissions?.capabilities ?? [])],
		netHosts: [...(m.permissions?.net?.hosts ?? [])],
	};
}
