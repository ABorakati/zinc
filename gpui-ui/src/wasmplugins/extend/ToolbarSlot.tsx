// Toolbar buttons and small views that plugins registered (`extend.register-toolbar-button`, `register-toolbar-view`), drawn in the
// library toolbar and the top bar. Nothing is drawn (and nothing is added to the layout) while no plugin registered one.
import { For, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { Icon } from "../../icons";
import { t, tok, tx } from "../../shell/kit";
import { openMenu, type MenuItem } from "../../ui";
import { callPlugin } from "../host";
import { conditionHolds } from "./conditions";
import { buildContext, conditionContext } from "./context";
import { resolveEntries, runMenuCommand, showingOne, type ResolvedEntry } from "./menus";
import { buttonStates, registries, toggled, type Owned } from "./registry";
import { iconName, lstr } from "./text";
import type { ToolbarButtonRegistration, ToolbarSlot } from "./wit";
import { PluginViewSlot } from "./viewSlot";

const byOrder = <T extends { reg: { order: number } }>(a: T, b: T) => a.reg.order - b.reg.order;

/** The menu items of a button's (or any registration's) resolved entries. */
export function toMenuItems(list: ResolvedEntry[]): MenuItem[] {
	return list.map((e): MenuItem => {
		if (e.kind === "separator") return { separator: true };
		if (e.kind === "submenu") return { label: e.label, icon: e.icon, submenu: toMenuItems(e.children), disabled: e.disabled };
		return {
			label: e.label,
			icon: e.icon,
			checked: e.checked,
			disabled: e.disabled,
			shortcut: e.accelerator,
			onSelect: () => void runMenuCommand(e, buildContext(), e.checked === undefined ? undefined : !e.checked),
		};
	});
}

function Button(p: { b: Owned<ToolbarButtonRegistration>; compact?: boolean }): JSX.Element {
	const state = () => buttonStates.get(p.b.plugin, p.b.id);
	const x = () => conditionContext();
	const visible = () => !state()?.hidden && conditionHolds(p.b.reg.visibleWhen, x());
	const disabled = () => !!state()?.disabled || !conditionHolds(p.b.reg.enabledWhen, x());
	const on = () => (p.b.reg.toggle != null ? !!toggled.get(p.b.plugin, p.b.id) : false);
	const icon = () => iconName(state()?.icon ?? p.b.reg.icon);
	const tooltip = () => lstr(state()?.tooltip ?? p.b.reg.tooltip, p.b.id);
	const click = async (e: EventPayload) => {
		if (disabled()) return;
		const menu = p.b.reg.menu ?? [];
		if (menu.length) {
			if (menu.some((m) => m.hooks?.showing)) await Promise.race([showingOne(p.b.plugin, p.b.id, buildContext()), new Promise((r) => setTimeout(r, 120))]);
			const list = resolveEntries(p.b.plugin, p.b.id, menu, x());
			if (list.length) openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, toMenuItems(list));
			return;
		}
		let next: boolean | undefined;
		if (p.b.reg.toggle != null) {
			next = !on();
			toggled.set(p.b.plugin, p.b.id, next);
		}
		try {
			await callPlugin(p.b.plugin, "extend-handlers", "on-toolbar-click", [p.b.id, next, buildContext()]);
		} catch (err) {
			console.error(`[plugin ${p.b.plugin}] toolbar button ${p.b.id} failed:`, err instanceof Error ? err.message : err);
		}
	};
	return (
		<Show when={visible()}>
			<div
				role="button"
				aria-label={tooltip()}
				testId={`plugin-toolbar-${p.b.plugin}-${p.b.id}`}
				onClick={(e: EventPayload) => void click(e)}
				style={{
					...t("flex h-8 flex-none items-center justify-center rounded-lg px-2 gap-1.5"),
					cursor: disabled() ? "default" : "pointer",
					opacity: disabled() ? 0.4 : 1,
					...(on() ? t("bg-foreground/10") : {}),
					hover: disabled() ? undefined : t("bg-foreground/5"),
				}}
			>
				<Icon name={icon()} size={16} color={tok(on() ? "foreground" : "muted-foreground")} />
				<Show when={p.b.reg.label}>
					<text style={{ ...tx("text-[13px] text-muted-foreground"), whiteSpace: "nowrap" }}>{lstr(p.b.reg.label)}</text>
				</Show>
				<Show when={state()?.badge}>
					<text style={{ ...tx("text-[11px] font-semibold text-primary"), whiteSpace: "nowrap" }}>{state()!.badge!}</text>
				</Show>
			</div>
		</Show>
	);
}

/** The plugin buttons and views of one toolbar slot. */
export function PluginToolbarSlot(p: { slot: ToolbarSlot }): JSX.Element {
	const buttons = () => registries.toolbarButtons.list().filter((b) => b.reg.slot === p.slot).sort(byOrder);
	const views = () => registries.toolbarViews.list().filter((v) => v.reg.slot === p.slot && conditionHolds(v.reg.visibleWhen, conditionContext())).sort(byOrder);
	return (
		<Show when={buttons().length || views().length}>
			<div style={{ ...t("flex flex-none items-center gap-1"), marginLeft: 6 }}>
				<For each={views()}>
					{(v) => (
						<div style={{ width: v.reg.width ?? undefined, flexShrink: 0 }}>
							<PluginViewSlot plugin={v.plugin} view={v.id} surface="toolbar-slot" params={{ window: 1, slot: p.slot }} width={v.reg.width ?? undefined} />
						</div>
					)}
				</For>
				<For each={buttons()}>{(b) => <Button b={b} />}</For>
			</div>
		</Show>
	);
}
