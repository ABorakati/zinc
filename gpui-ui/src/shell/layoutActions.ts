// Layout commands for the Tools menu and user-defined shortcuts. No default keys compete with content undo.
import { registerAppAction } from "../registry";
import { canUndoLayout, resetCols, resetLayout, undoLayout } from "./layout";
import { editLayout, layoutEditing } from "./layoutEdit";

registerAppAction({
	id: "layout-edit",
	label: () => (layoutEditing() ? "Finish editing layout" : "Edit layout"),
	icon: "layout-dashboard",
	menu: "tools",
	run: () => editLayout(!layoutEditing()),
});
registerAppAction({
	id: "layout-undo",
	label: "Undo layout change",
	icon: "undo-2",
	menu: "tools",
	when: () => canUndoLayout(),
	run: () => {
		undoLayout();
	},
});
registerAppAction({ id: "layout-reset-sizes", label: "Reset pane sizes", menu: "tools", run: resetCols });
registerAppAction({ id: "layout-reset", label: "Reset layout", menu: "tools", run: () => void resetLayout() });
