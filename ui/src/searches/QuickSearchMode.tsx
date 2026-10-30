import { For, type Component } from "solid-js";
import { ChevronDown } from "lucide-solid";
import { store, type QMode } from "~/store";
import { cn } from "~/lib/utils";

export const QUICK_MODES: { mode: QMode; label: string; hint: string }[] = [
	{ mode: "titleCreatorYear", label: "Title, Creator, Year", hint: "Match words in the title, creators or year" },
	{ mode: "fields", label: "All Fields & Tags", hint: "Match any field, creator or tag" },
	{ mode: "everything", label: "Everything", hint: "Also match notes and attachment full text" },
];

/**
 * Compact mode picker for the toolbar search box (mount it beside the filter input in App.tsx).
 * The same modes are in the Tools menu. The native arrow is hidden and drawn here, centred like the other toolbar icons.
 */
export const QuickSearchMode: Component<{ class?: string }> = (p) => (
	<span class="relative inline-flex flex-none items-center">
		<select
			aria-label="Quick search mode"
			title="Quick search mode"
			class={cn("h-7 max-w-36 appearance-none rounded-md border border-input bg-background pl-1.5 pr-6 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30", p.class)}
			value={store.qmode()}
			onChange={(e) => store.setQMode(e.currentTarget.value as QMode)}
		>
			<For each={QUICK_MODES}>{(m) => <option value={m.mode} title={m.hint}>{m.label}</option>}</For>
		</select>
		<ChevronDown aria-hidden="true" class="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
	</span>
);
