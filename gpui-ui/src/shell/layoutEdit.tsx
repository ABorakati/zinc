// Edit layout mode. In normal use the panes draw no headers (the window looks as it did before layouts); a stack shows a tab
// strip only when it holds two or more panes. Edit mode shows every pane's header with a grip and its menu, so panes can be
// dragged, stacked, moved and hidden; a bar above the library says so and has Reset and Done. Escape leaves it.
// Entered from Settings > Appearance > Layout ("Customize…") or the Tools menu ("Edit layout").
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { Button } from "../ui";
import { t, tok, tx } from "../ui/core";
import { paneDragging } from "./dock";
import { resetLayout } from "./layout";
import { addKeyHandler } from "./shortcuts";

const [editing, setEditing] = createSignal(false);
/** Whether edit layout mode is on. */
export const layoutEditing = editing;

/** Turn edit layout mode on (showing the library) or off. */
export function editLayout(on = true): void {
	setEditing(on);
	if (on) store.setActiveTab("library");
}

/** The bar above the library while editing. */
export function LayoutEditBar(): JSX.Element {
	onMount(() =>
		onCleanup(
			addKeyHandler((e) => {
				if (e.key !== "escape" || paneDragging()) return false; // a drag takes Escape first (dock.tsx)
				editLayout(false);
				return true;
			}),
		),
	);
	return (
		<div
			testId="layout-edit-bar"
			role="status"
			style={{
				...t("flex flex-none items-center gap-2 rounded-[10px] px-3 py-1.5"),
				width: "100%",
				backgroundColor: tok("primary-tint"),
			}}
		>
			<Icon name="layout-dashboard" size={15} color={tok("primary-deep")} />
			<text style={{ ...tx("text-[13px]"), color: tok("primary-deep"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
				Editing layout: drag a pane by its header, or use its ⋯ menu to move, stack or hide it.
			</text>
			<Button variant="ghost" size="sm" onClick={() => resetLayout()}>
				Reset
			</Button>
			<Button variant="primary" size="sm" onClick={() => editLayout(false)}>
				Done
			</Button>
		</div>
	);
}
