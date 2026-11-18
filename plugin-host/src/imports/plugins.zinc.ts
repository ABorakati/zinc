// `plugins` (lifecycle.wit): the plugin's own record (always allowed) and, with `plugins.read`, other plugins' records, icons and
// lifecycle events; `check-update` asks the plugin's `update_url`. A plugin cannot install an update: the user does that in Settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineHandler, witError, type HandlerContext } from "./registry";
import { getServices } from "../package/services";
import type { InstalledPlugin } from "../package/installer";
import { checkForUpdate } from "../package/update";
import { requirePermission } from "../permissions/check";

function wireInfo(p: InstalledPlugin) {
	return {
		id: p.id,
		name: p.name,
		version: p.version,
		description: p.description,
		author: p.author,
		homepage: p.homepage,
		state: p.state,
		stateDetail: p.stateDetail,
		granted: p.granted,
	};
}

/** The record of a plugin the manager does not know (loaded straight into the supervisor, as tests and dev mode do): its manifest, enabled. */
function ownInfo(ctx: HandlerContext) {
	const p = getServices().manager.get(ctx.pluginId);
	if (p) return wireInfo(p);
	const m = ctx.manifest;
	return {
		id: m.id,
		name: m.name,
		version: m.version,
		description: typeof m.description === "string" ? m.description : undefined,
		author: typeof m.author === "string" ? m.author : undefined,
		homepage: typeof m.homepage_url === "string" ? m.homepage_url : undefined,
		state: "enabled",
		stateDetail: undefined,
		granted: [...ctx.grants.capabilities, ...ctx.grants.netHosts.map((h) => `net.hosts:${h}`)],
	};
}

const other = (ctx: HandlerContext, id: string) => {
	if (id !== ctx.pluginId) requirePermission(ctx, "plugins.read");
};

/** Icon size keys of a manifest, the PNG closest to `size` (an SVG cannot be returned as PNG bytes, so only PNGs count). */
function pickIcon(icons: Record<string, string> | undefined, size: number): string | undefined {
	const png = Object.entries(icons ?? {}).filter(([, f]) => /\.png$/i.test(f));
	if (!png.length) return undefined;
	png.sort((a, b) => Math.abs(Number(a[0]) - size) - Math.abs(Number(b[0]) - size));
	return png[0][1];
}

export default defineHandler({
	interface: "zinc:plugin/plugins",
	where: "zinc",
	functions: {
		"self-info": (ctx) => ownInfo(ctx),
		// get-info, list-plugins and get-icon return no `result`, so they cannot say permission-denied (and a handler that throws would make
		// the plugin trap). Without `plugins.read` they answer as if the other plugins did not exist. WIT note in phase2-pkg.md.
		"get-info"(ctx, id: string) {
			if (id === ctx.pluginId) return ownInfo(ctx);
			if (!ctx.has("plugins.read")) return undefined;
			const p = getServices().manager.get(id);
			return p ? wireInfo(p) : undefined;
		},
		"list-plugins"(ctx) {
			if (!ctx.has("plugins.read")) return [ownInfo(ctx)];
			return getServices().manager.list().map(wireInfo);
		},
		"get-icon"(ctx, id: string, sizePx: number) {
			if (id !== ctx.pluginId && !ctx.has("plugins.read")) return undefined;
			const p = getServices().manager.get(id);
			const file = p && pickIcon((p.manifest as { icons?: Record<string, string> }).icons, sizePx);
			if (!p || !file) return undefined;
			try {
				return new Uint8Array(readFileSync(join(p.dir, ...file.split("/"))));
			} catch {
				return undefined;
			}
		},
		async "check-update"(ctx, id: string) {
			other(ctx, id);
			const s = getServices();
			const manifest = id === ctx.pluginId ? ctx.manifest : s.manager.manifestOf(id);
			if (!manifest) throw witError("not-found", `plugin ${id}`);
			try {
				const u = await checkForUpdate(manifest, { zincVersion: s.manager.zincVersion, fetch: s.updateFetch });
				return u ? { version: u.version, notesUrl: u.notesUrl } : undefined;
			} catch (e) {
				throw witError("unavailable", `update check failed: ${(e as Error).message}`);
			}
		},
		"observe-plugins"(ctx) {
			requirePermission(ctx, "plugins.read");
			getServices().observePlugins(ctx.pluginId);
		},
		"stop-observing-plugins"(ctx) {
			getServices().stopObservingPlugins(ctx.pluginId);
		},
	},
});
