// Registry behind the Keyboard Shortcuts dialog and the dialog itself. Commands (app actions) are listed with the key they have now;
// features add entries here only for fixed keys of lists and panes, which are not commands.
import { createSignal, For, type JSX } from "solid-js";
import { Button, openDialog } from "../../ui";
import { Footer, Line, Scroll, t, Txt } from "../kit";
import { appActions } from "../../registry";
import { actionShortcut } from "../../shell/shortcuts";

export interface ShortcutEntry {
	keys: string; // display text, e.g. "Ctrl+Shift+N"
	description: string;
	group?: string; // heading in the dialog; default "General"
}

const [entries, setEntries] = createSignal<ShortcutEntry[]>([]);
export { entries as shortcutEntries };

/** Add shortcuts to the help dialog (an entry with the same group, keys and description is replaced). */
export function registerShortcutHelp(list: ShortcutEntry[]): void {
	setEntries((cur) => {
		const k = (e: ShortcutEntry) => `${e.group ?? "General"}|${e.keys}|${e.description}`;
		const incoming = new Set(list.map(k));
		return [...cur.filter((e) => !incoming.has(k(e))), ...list];
	});
}

const ORDER = ["Commands", "General", "Items", "Navigation"];
/** The entries plus every command that has a key now (Settings > Shortcuts may have changed it). */
function groups(): [string, ShortcutEntry[]][] {
	const commands: ShortcutEntry[] = appActions()
		.map((a) => ({
			keys: actionShortcut(a) ?? "",
			description: typeof a.label === "function" ? a.label() : a.label,
			group: "Commands",
		}))
		.filter((e) => e.keys)
		.sort((a, b) => a.description.localeCompare(b.description));
	const m = new Map<string, ShortcutEntry[]>();
	for (const e of [...commands, ...entries()]) {
		const g = e.group ?? "General";
		m.set(g, [...(m.get(g) ?? []), e]);
	}
	return [...m.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99));
}

function ShortcutsDialog(p: { close: () => void }): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Scroll height={420}>
				<For each={groups()}>
					{([g, list]) => (
						<div style={{ ...t("flex flex-col gap-1"), flexShrink: 0, marginBottom: 12 }}>
							<Txt class="text-[11px] font-semibold text-muted-foreground">{g.toUpperCase()}</Txt>
							<For each={list}>
								{(e) => (
									<div style={{ ...t("flex flex-row items-center gap-4 py-0.5"), width: "100%" }}>
										<Line class="text-sm text-foreground" style={{ flexGrow: 1 }}>
											{e.description}
										</Line>
										<div style={{ ...t("flex-none rounded border bg-muted px-1.5 py-0.5"), flexShrink: 0 }}>
											<Txt class="text-xs text-foreground" style={{ whiteSpace: "nowrap" }}>
												{e.keys}
											</Txt>
										</div>
									</div>
								)}
							</For>
						</div>
					)}
				</For>
			</Scroll>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>
					Close
				</Button>
			</Footer>
		</div>
	);
}

let open = false;
export function showShortcutHelp(): void {
	if (open) return;
	open = true;
	void openDialog<void>((close) => <ShortcutsDialog close={() => close()} />, { title: "Keyboard shortcuts", width: 520 }).finally(() => {
		open = false;
	});
}
