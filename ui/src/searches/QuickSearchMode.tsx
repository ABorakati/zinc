import { For, type Component } from "solid-js";
import { store, type QMode } from "~/store";
import { cn } from "~/lib/utils";

export const QUICK_MODES: { mode: QMode; label: string; hint: string }[] = [
	{ mode: "titleCreatorYear", label: "Title, Creator, Year", hint: "Match words in the title, creators or year" },
	{ mode: "fields", label: "All Fields & Tags", hint: "Match any field, creator or tag" },
	{ mode: "everything", label: "Everything", hint: "Also match notes and attachment full text" },
];

/**
 * Compact mode picker for the toolbar search box (mount it beside the filter input in App.tsx).
 * The same modes are in the Tools menu.
 */
export const QuickSearchMode: Component<{ class?: string }> = (p) => (
	<select
		aria-label="Quick search mode"
		title="Quick search mode"
		class={cn("h-7 max-w-36 rounded-md border border-input bg-background px-1.5 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30", p.class)}
		value={store.qmode()}
		onChange={(e) => store.setQMode(e.currentTarget.value as QMode)}
	>
		<For each={QUICK_MODES}>{(m) => <option value={m.mode} title={m.hint}>{m.label}</option>}</For>
	</select>
);
