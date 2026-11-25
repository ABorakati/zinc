// Small hooks the existing app files call. Kept light (no UI imports) because cards/menus.ts and others import it even while plugins
// are off: every function here is a no-op until plugins start and bind the extend host.
import { menuShowing } from "./menus";
import { getExtendHost } from "./navigation";
import { registries } from "./registry";
import type { MenuTarget } from "./wit";

/** Before a menu of `target` opens: let plugins with an `on-menu-showing` hook patch their entries (waits at most 120 ms). Returns true if any plugin hook ran. */
export async function beforePluginMenu(target: MenuTarget): Promise<boolean> {
	const host = getExtendHost();
	if (!host || !registries.menus.list().some((m) => m.reg.target === target)) return false;
	await menuShowing(target, host.getContext());
	return true;
}
