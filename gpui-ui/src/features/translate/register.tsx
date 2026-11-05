// Registers "Add from URL…" in the Add menu (next to Add Item by Identifier).
import { registerAppAction } from "../../registry";
import { openWebDialog } from "./WebDialog";

export function register(): void {
	registerAppAction({ id: "add.url", label: "Add from URL…", icon: "globe", menu: "add", run: () => void openWebDialog() });
}
