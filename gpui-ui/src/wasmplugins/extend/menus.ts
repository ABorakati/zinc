// Menus registered with `extend.register-menu` (and the entries of toolbar button menus): resolving them for the current context,
// the `on-menu-showing` round trip and command dispatch. UI-free: the components turn ResolvedEntry into their own menu items.
import { callPlugin } from "../host";
import { conditionHolds, type CondCtx } from "./conditions";
import { menuPatches, registries } from "./registry";
import { iconName, lstr } from "./text";
import type { Context, EntryPatch, MenuEntry, MenuTarget } from "./wit";

export interface ResolvedEntry {
	plugin: string;
	/** The registration (or toolbar button) the entry belongs to; what `on-menu-command` gets as `menu-id`. */
	menuId: string;
	id: string;
	kind: "item" | "separator" | "submenu";
	label: string;
	icon?: string;
	checked?: boolean;
	accelerator?: string;
	disabled: boolean;
	children: ResolvedEntry[];
}

/** Turn a flat entry list into the tree, applying conditions and patches. Hidden entries are left out. */
export function resolveEntries(plugin: string, menuId: string, entries: MenuEntry[], x: CondCtx): ResolvedEntry[] {
	const patches = menuPatches.get(plugin, menuId);
	const make = (e: MenuEntry): ResolvedEntry | undefined => {
		const p: EntryPatch | undefined = patches?.get(e.id);
		if (p?.hidden || !conditionHolds(e.visibleWhen, x)) return undefined;
		const children =
			e.kind === "submenu" ? entries.filter((c) => c.parent === e.id).map(make).filter((c): c is ResolvedEntry => !!c) : [];
		if (e.kind === "submenu" && !children.length) return undefined;
		return {
			plugin,
			menuId,
			id: e.id,
			kind: e.kind,
			label: lstr(p?.label ?? e.label),
			icon: e.icon || p?.icon ? iconName(p?.icon ?? e.icon, "") || undefined : undefined,
			checked: p?.checked ?? (e.check ?? undefined),
			accelerator: e.accelerator ?? undefined,
			disabled: !!p?.disabled || !conditionHolds(e.enabledWhen, x),
			children,
		};
	};
	return entries
		.filter((e) => !e.parent)
		.map(make)
		.filter((e): e is ResolvedEntry => !!e)
		.filter((e, i, l) => e.kind !== "separator" || (i > 0 && i < l.length - 1 && l[i - 1]!.kind !== "separator"));
}

/** Everything registered for a target, in registration order, resolved for the context. */
export function resolveTarget(target: MenuTarget, x: CondCtx): ResolvedEntry[] {
	const out: ResolvedEntry[] = [];
	for (const m of registries.menus.list()) {
		if (m.reg.target !== target) continue;
		const list = resolveEntries(m.plugin, m.id, m.reg.entries, x);
		if (list.length && out.length && out[out.length - 1]!.kind !== "separator") out.push({ plugin: m.plugin, menuId: m.id, id: "-", kind: "separator", label: "", disabled: false, children: [] });
		out.push(...list);
	}
	return out;
}

/** Wait this long for `on-menu-showing` (extend.wit: 120 ms). The call itself is not cancelled: its answer is kept for the next time. */
export const SHOWING_WAIT_MS = 120;

/** Before a menu of `target` opens: ask the plugins whose entries have the `showing` hook for patches, waiting at most 120 ms. */
export async function menuShowing(target: MenuTarget, ctx: Context): Promise<void> {
	const jobs: Promise<void>[] = [];
	for (const m of registries.menus.list()) {
		if (m.reg.target !== target || !m.reg.entries.some((e) => e.hooks?.showing)) continue;
		jobs.push(showingOne(m.plugin, m.id, ctx));
	}
	if (!jobs.length) return;
	await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, SHOWING_WAIT_MS))]);
}

/** `on-menu-showing` for one registration or toolbar button menu. */
export async function showingOne(plugin: string, menuId: string, ctx: Context): Promise<void> {
	try {
		const patches = (await callPlugin(plugin, "extend-handlers", "on-menu-showing", [menuId, ctx])) as EntryPatch[];
		const m = new Map(menuPatches.get(plugin, menuId));
		// each showing answer replaces the previous one's hidden/disabled state (the plugin decides again every time)
		for (const k of [...m.keys()]) m.delete(k);
		for (const p of patches ?? []) m.set(p.id, p);
		menuPatches.set(plugin, menuId, m);
	} catch {
		/* a failing or slow handler: the menu opens with the last patches */
	}
}

/** The user chose an entry. */
export async function runMenuCommand(e: Pick<ResolvedEntry, "plugin" | "menuId" | "id" | "checked">, ctx: Context, newChecked?: boolean): Promise<void> {
	try {
		await callPlugin(e.plugin, "extend-handlers", "on-menu-command", [e.menuId, e.id, newChecked ?? undefined, ctx]);
	} catch (err) {
		console.error(`[plugin ${e.plugin}] menu command ${e.menuId}/${e.id} failed:`, err instanceof Error ? err.message : err);
	}
}

/** Fire-and-forget phases (`shown`, `hiding`, `hidden`). */
export function menuPhase(plugin: string, menuId: string, entryId: string, phase: "shown" | "hiding" | "hidden", ctx: Context): void {
	void callPlugin(plugin, "extend-handlers", "on-menu-phase", [menuId, entryId, phase, ctx]).catch(() => {});
}
