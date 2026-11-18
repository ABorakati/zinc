// Settings: the "Plugins" section (the switch that turns plugins on, and the list of what is loaded) and the preference panes plugins
// registered (`extend.register-pref-pane`), each as a section of Settings. Rows are the host's own controls bound to plugin prefs (no
// plugin code runs to draw them); a `view` pane or a `custom` row is a PluginView.
import { createEffect, createMemo, createRoot, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Choice, Btn, SettingRow, TextField, Toggle, Value } from "../../settings/controls";
import { registerSettingsSection, unregisterSettingsSection } from "../../registry";
import { Txt, t } from "../../shell/kit";
import { callPlugin } from "../host";
import { setWasmPluginsEnabled, wasmPluginsEnabled } from "../flag";
import { mcpExposed, setMcpExposed } from "../mcp/exposure";
import { prefCell } from "./prefs";
import { prefRows, registries, type Owned } from "./registry";
import { lstr, iconName } from "./text";
import type { PrefPaneRegistration, PrefValue, SettingRow as SettingRowReg } from "./wit";
import { PluginViewSlot } from "./viewSlot";

// ---- helpers ---------------------------------------------------------------------------------------------------------------

const asText = (v: PrefValue | undefined): string => (v ? String(v.val) : "");
const asFlag = (v: PrefValue | undefined): boolean => v?.tag === "flag" && v.val;
const equals = (a: PrefValue | undefined, b: PrefValue): boolean => !!a && a.tag === b.tag && a.val === b.val;

function RowView(p: { plugin: string; pane: string; row: SettingRowReg; last: boolean }): JSX.Element {
	const r = p.row;
	const cond = (c: SettingRowReg["enabledWhen"]) => {
		if (!c) return true;
		return equals(prefCell(p.plugin, c.pref).get(), c.equals);
	};
	const control = (): JSX.Element => {
		const c = r.control;
		switch (c.tag) {
			case "toggle": {
				const cell = prefCell(p.plugin, c.val);
				return <Toggle checked={asFlag(cell.get())} onChange={(v) => void cell.set({ tag: "flag", val: v })} />;
			}
			case "text": {
				const cell = prefCell(p.plugin, c.val.pref);
				return (
					<TextField
						value={c.val.secret ? "" : asText(cell.get())}
						placeholder={c.val.secret ? "(hidden)" : lstr(c.val.placeholder)}
						onCommit={(v) => void cell.set({ tag: "text", val: v })}
					/>
				);
			}
			case "number": {
				const cell = prefCell(p.plugin, c.val.pref);
				return (
					<TextField
						value={asText(cell.get())}
						width={96}
						onCommit={(v) => {
							let n = Math.trunc(Number(v));
							if (!Number.isFinite(n)) return;
							if (c.val.min != null) n = Math.max(c.val.min, n);
							if (c.val.max != null) n = Math.min(c.val.max, n);
							void cell.set({ tag: "integer", val: n });
						}}
					/>
				);
			}
			case "choice": {
				const cell = prefCell(p.plugin, c.val.pref);
				return (
					<Choice
						value={asText(cell.get())}
						options={c.val.options.map((o) => ({ value: o.value, label: lstr(o.label, o.value) }))}
						onChange={(v) => void cell.set({ tag: "text", val: v })}
					/>
				);
			}
			case "button":
				return (
					<Btn onClick={() => void callPlugin(p.plugin, "extend-handlers", "on-pref-action", [p.pane, c.val.actionId]).catch(() => {})}>
						{lstr(c.val.text, c.val.actionId)}
					</Btn>
				);
			case "custom":
				return (
					<div style={{ width: "100%", height: c.val ?? undefined }}>
						<PluginViewSlot plugin={p.plugin} view={`${p.pane}/${r.id}`} surface="preferences-pane" params={{ paneID: p.pane, rowID: r.id }} height={c.val ?? undefined} />
					</div>
				);
			default:
				return <></>;
		}
	};
	return (
		<Show when={cond(r.visibleWhen)}>
			<div style={{ width: "100%", opacity: cond(r.enabledWhen) ? 1 : 0.5 }}>
				<SettingRow
					id={`plugin:${p.plugin}:${p.pane}:${r.id}`}
					label={lstr(r.label, r.id)}
					description={r.description ? lstr(r.description) : undefined}
					layout={r.control.tag === "custom" ? "block" : "inline"}
					control={control}
					last={p.last}
				/>
			</div>
		</Show>
	);
}

function PaneBody(p: { pane: Owned<PrefPaneRegistration> }): JSX.Element {
	const rows = (): SettingRowReg[] => prefRows.get(p.pane.plugin, p.pane.id) ?? (p.pane.reg.content.tag === "rows" ? p.pane.reg.content.val : []);
	onMount(() => {
		if (p.pane.reg.openCloseHooks) void callPlugin(p.pane.plugin, "extend-handlers", "on-pref-pane-open", [p.pane.id]).catch(() => {});
	});
	onCleanup(() => {
		if (p.pane.reg.openCloseHooks) void callPlugin(p.pane.plugin, "extend-handlers", "on-pref-pane-close", [p.pane.id]).catch(() => {});
	});
	return (
		<Show
			when={p.pane.reg.content.tag === "rows"}
			fallback={<PluginViewSlot plugin={p.pane.plugin} view={p.pane.id} surface="preferences-pane" params={{ paneID: p.pane.id, rowID: null }} />}
		>
			<div style={{ ...t("flex flex-col"), width: "100%" }}>
				<For each={rows()}>
					{(row, i) => (
						<>
							<Show when={row.group && (i() === 0 || lstr(rows()[i() - 1]?.group) !== lstr(row.group))}>
								<div style={t("pt-3 pb-1")}>
									<Txt cls="text-[11px] font-semibold text-muted-foreground tracking-wide">{lstr(row.group).toUpperCase()}</Txt>
								</div>
							</Show>
							<RowView plugin={p.pane.plugin} pane={p.pane.id} row={row} last={i() === rows().length - 1} />
						</>
					)}
				</For>
			</div>
		</Show>
	);
}

/** Id of a plugin pane's Settings section (what `open-settings` goes to). */
export const paneSectionId = (plugin: string, pane: string) => `plugin:${plugin}:${pane}`;

/** Mirror the registered panes into Settings sections. Call once, inside the plugin start-up. */
export function startPaneMirror(): () => void {
	return createRoot((dispose) => {
		const shown = new Set<string>();
		createEffect(() => {
			const panes = registries.prefPanes.list();
			for (const id of shown) unregisterSettingsSection(id);
			shown.clear();
			for (const p of panes) {
				if (p.reg.parent) continue; // a child pane opens from its parent: drawn under it
				const id = paneSectionId(p.plugin, p.id);
				const kids = createMemo(() => registries.prefPanes.list().filter((k) => k.plugin === p.plugin && k.reg.parent === p.id));
				shown.add(id);
				registerSettingsSection({
					id,
					label: lstr(p.reg.label, p.plugin),
					icon: p.reg.icon ? iconName(p.reg.icon, "puzzle") : "puzzle",
					order: 900 + p.reg.order,
					render: () => (
						<div style={{ ...t("flex flex-col"), width: "100%" }}>
							<PaneBody pane={p} />
							<For each={kids()}>{(k) => <PaneBody pane={k} />}</For>
						</div>
					),
				});
			}
		});
		return dispose;
	});
}

// ---- the Plugins section ---------------------------------------------------------------------------------------------------

/** Settings > Plugins: the switch and the list. Registered once at start-up (src/features.ts), always, so plugins can be turned on. */
export function registerPluginsSettings(
	list: () => { id: string; name: string; version: string; status: string; /** set when the plugin asks for `mcp.expose`: how many tools its manifest declares */ mcpTools?: number }[],
): void {
	registerSettingsSection({
		id: "wasm-plugins",
		label: "Plugins",
		icon: "puzzle",
		order: 850,
		render: () => (
			<div style={{ ...t("flex flex-col"), width: "100%" }}>
				<SettingRow
					id="wasm-plugins-enabled"
					label="Enable plugins (experimental)"
					description="Runs installed plugins in a separate process. Takes effect the next time Zinc starts."
					control={() => <Toggle checked={wasmPluginsEnabled()} onChange={setWasmPluginsEnabled} />}
				/>
				<For each={list()}>
					{(p, i) => (
						<>
							<SettingRow
								label={`${p.name} ${p.version}`}
								control={() => <Value>{p.status}</Value>}
								last={i() === list().length - 1 && p.mcpTools === undefined}
							/>
							<Show when={p.mcpTools !== undefined}>
								<SettingRow
									id={`wasm-plugin-mcp:${p.id}`}
									label={`Offer ${p.name}'s tools to AI agents`}
									description={`Lets AI agents connected to Zinc's MCP server (HTTP, while Zinc runs) call this plugin's tools${p.mcpTools ? ` (${p.mcpTools} declared)` : ""}. They can do whatever the plugin is allowed to do. Off by default.`}
									control={() => <Toggle checked={mcpExposed(p.id)} onChange={(on) => setMcpExposed(p.id, on)} />}
									last={i() === list().length - 1}
								/>
							</Show>
						</>
					)}
				</For>
			</div>
		),
	});
}
