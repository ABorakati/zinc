// Duplicate Items: the merge dialog opens when the sidebar's "Duplicate Items" view is selected, from Tools, and from the
// item menu ("Merge Items…" on two or more selected items).
import { createEffect, on } from "solid-js";
import { registerAppAction, registerItemAction, registerOverlay } from "../../registry";
import { currentView, setView } from "../shared";
import { openDuplicates } from "./DuplicatesDialog";

let opening = false;
async function openForView(): Promise<void> {
	if (opening) return;
	opening = true;
	try {
		await openDuplicates();
	} finally {
		opening = false;
		if (currentView().kind === "duplicates") setView({ kind: "library" }); // closing the dialog leaves the (list-only) duplicates view
	}
}

/** Mounted once (an always-on overlay): watches the selected view. Renders nothing visible. */
function ViewWatcher() {
	createEffect(
		on(
			() => currentView().kind,
			(k) => {
				if (k === "duplicates") void openForView();
			},
		),
	);
	return <div style={{ position: "absolute", width: 0, height: 0 }} />;
}

export function register(): void {
	registerOverlay("duplicates-view-watcher", () => <ViewWatcher />);

	registerItemAction({
		id: "duplicates.merge-items",
		label: "Merge Items…",
		icon: "git-merge",
		group: "maintain",
		visible: (ctx) => ctx.view.kind !== "trash" && ctx.keys.length >= 2,
		run: (ctx) => void openDuplicates(ctx.keys),
	});

	registerAppAction({
		id: "duplicates.open-panel",
		label: "Duplicate Items…",
		icon: "git-merge",
		menu: "tools",
		run: () => void openDuplicates(),
	});
}
