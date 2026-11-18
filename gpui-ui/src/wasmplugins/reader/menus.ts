// The reader's menus (`menu(kind)` registrations): a static menu is shown from the registration; a dynamic one asks the plugin's
// `reader-events.build-menu`. Zinc's menu layer reads its items once, when the menu opens, so a dynamic menu uses what the last
// answer was: the annotation and thumbnail menus wait for the plugin (openAfterPlugins in reader/plugins.ts: at most 600 ms), the view
// and colour menus are asked for ahead of time (warmMenus). An answer is reused for a second, then asked for again.
// Documented in phase2-reader.md ("Menus").
import { createSignal } from "solid-js";
import type { MenuItem } from "../../ui/core";
import { holdMenu } from "../../reader/plugins";
import { menuEntriesToItems } from "./convert";
import { callPlugin, notifyPlugin } from "./link";
import { pluginsWithRegs, regsOf } from "./registry";
import type { MenuContext, MenuEntry, MenuKind, MenuParams, ReaderInfo } from "./types";

const TTL_MS = 1000;
const MAX_CACHE = 200;
const cache = new Map<string, { at: number; entries: MenuEntry[] }>();
const inflight = new Set<string>();
const [tick, setTick] = createSignal(0);

/** What identifies one opening of a menu for the cache (annotation keys and pages, not the annotation bodies). */
function paramsKey(p: MenuParams): string {
	switch (p.tag) {
		case "annotation":
			return `a:${p.val.annotations.map((a) => `${a.key}@${a.dateModified}`).join(",")}:${p.val.current ?? ""}:${p.val.fromView}`;
		case "thumbnail":
			return `t:${p.val.join(",")}`;
		case "selector":
			return `s:${p.val.enableClearSelection}`;
		case "theme":
			return `m:${p.val}`;
		default:
			return p.tag;
	}
}

function dynamicEntries(plugin: string, listener: string, ctx: MenuContext): MenuEntry[] {
	const key = `${plugin}\u0000${listener}\u0000${ctx.reader.id}\u0000${paramsKey(ctx.params)}`;
	const hit = cache.get(key);
	if (!hit || Date.now() - hit.at > TTL_MS) {
		if (!inflight.has(key)) {
			inflight.add(key);
			const p = callPlugin(plugin, "reader-events", "build-menu", [listener, ctx]);
			holdMenu(p.catch(() => {}));
			void p
				.then((r) => {
					if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
					cache.set(key, { at: Date.now(), entries: Array.isArray(r) ? (r as MenuEntry[]) : [] });
					setTick((n) => n + 1);
				})
				.catch((e) => console.error(`[wasm-reader] ${plugin} build-menu ${listener}:`, e instanceof Error ? e.message : e))
				.finally(() => inflight.delete(key));
		}
	}
	// reading the tick makes the caller (a menu's items function) run again when an answer arrives
	tick();
	return hit?.entries ?? [];
}

/** The items one plugin adds to a menu of this kind (empty when it registered none). */
export function pluginMenuFor(plugin: string, kind: MenuKind, reader: ReaderInfo, params: MenuParams): MenuItem[] {
	const regs = regsOf(plugin);
	if (!regs) return [];
	const ctx: MenuContext = { reader, params };
	const out: MenuItem[] = [];
	for (const reg of regs.listeners.values()) {
		if (reg.target.tag !== "menu" || reg.target.val !== kind) continue;
		if (reg.readerKinds.length && !reg.readerKinds.includes(reader.kind)) continue;
		const entries = reg.staticMenu.length ? reg.staticMenu : dynamicEntries(plugin, reg.id, ctx);
		const items = menuEntriesToItems(entries, (id) => notifyPlugin(plugin, "reader-events", "on-menu-command", [reg.id, id, ctx]));
		if (items.length && out.length) out.push({ separator: true });
		out.push(...items);
	}
	return out;
}

/**
 * Menus without parameters (view, color, theme) are asked for ahead of time, so the first opening already has the plugin's answer
 * (a menu opens with what it has; see openAfterPlugins in reader/plugins.ts for the ones that wait). Called when registrations or
 * the open readers change; `readers` are the readers' infos.
 */
export function warmMenus(readers: ReaderInfo[]): void {
	for (const reader of readers)
		for (const plugin of pluginsWithRegs())
			for (const reg of regsOf(plugin)?.listeners.values() ?? []) {
				if (reg.target.tag !== "menu" || reg.staticMenu.length) continue;
				const kind = reg.target.val;
				if (kind === "view" || kind === "color") dynamicEntries(plugin, reg.id, { reader, params: { tag: kind } });
			}
}

export function clearMenuCache(): void {
	cache.clear();
	inflight.clear();
}
