// Registers "Add from URL…" in the Add menu (next to Add Item by Identifier).
import { registerAppAction } from "../../registry";
import { store } from "../../store";
import { openWebDialog } from "./WebDialog";

export function register(): void {
	registerAppAction({ id: "add.url", label: "Add from URL…", icon: "globe", menu: "add", when: () => store.canEdit(), run: () => void openWebDialog() });
}
