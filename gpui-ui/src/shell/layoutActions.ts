// Layout commands for menus and user-defined shortcuts. No default keys compete with content undo.
import { registerAppAction } from "../registry";
import { standardLibrary } from "./frameLayout";
import { canUndoLayout, resetCols, setLibraryLayout, undoLayout } from "./layout";

registerAppAction({
	id: "layout-undo",
	label: "Undo layout change",
	icon: "undo-2",
	menu: "tools",
	when: () => canUndoLayout(),
	run: () => { undoLayout(); },
});
registerAppAction({ id: "layout-reset-sizes", label: "Reset pane sizes", menu: "tools", run: resetCols });
registerAppAction({
	id: "layout-reset-standard",
	label: "Reset layout to Standard",
	menu: "tools",
	run: () => setLibraryLayout(standardLibrary()),
});
