// Drop targets plugins registered (`extend.register-drop-target`). The window and the collection rows call `dropWithPlugins` with the
// files of an OS drop; the first matching plugin target gets `on-drop`; when it answers `ignored` (or none matches) the built-in
// handling goes on. The host never calls a plugin while a drag moves: only the drop is sent.
import { callPlugin } from "../host";
import { conditionHolds, type CondCtx } from "./conditions";
import { registries } from "./registry";
import type { Context, DropPayload, DropRegistration, FileGrant, TreeRow } from "./wit";

/** Turns a dropped path into a `types.file-grant`. The `fs` handler resolves the id (`fs.root::granted(id)`); set by whoever owns `fs`. */
let grantFor: (plugin: string, path: string) => FileGrant = (_plugin, path) => ({
	// no stat here (this file is also bundled for the web build): the size is unknown until the `fs` handler resolves the grant
	id: `drop:${path}`,
	name: path.split(/[\\/]/).pop() ?? path,
	isDirectory: false,
	size: undefined,
});
export function setDropGrantFactory(f: typeof grantFor): void {
	grantFor = f;
}

const extOf = (path: string) => /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

function matches(reg: DropRegistration, target: DropRegistration["target"], paths: string[]): boolean {
	if (reg.target !== target || !reg.accepts?.files || !paths.length) return false;
	const exts = (reg.extensions ?? []).map((e) => e.toLowerCase().replace(/^\./, ""));
	return !exts.length || paths.every((p) => exts.includes(extOf(p)));
}

/** True when a plugin target handled the drop. `ctx` is the context to hand over (the caller builds it); `row` / `item` say where. */
export async function dropWithPlugins(
	target: DropRegistration["target"],
	paths: string[],
	ctx: Context | undefined,
	where: { row?: TreeRow; item?: string } = {},
	conditionCtx?: CondCtx,
): Promise<boolean> {
	if (!paths.length) return false;
	for (const d of registries.dropTargets.list()) {
		if (!matches(d.reg, target, paths)) continue;
		if (conditionCtx && !conditionHolds(d.reg.enabledWhen, conditionCtx)) continue;
		const payload: DropPayload = {
			files: paths.map((p) => grantFor(d.plugin, p)),
			urls: [],
			text: undefined,
			items: [],
			row: where.row,
			item: where.item,
		};
		try {
			const out = (await callPlugin(d.plugin, "extend-handlers", "on-drop", [d.id, payload, ctx])) as "handled" | "ignored";
			if (out === "handled") return true;
		} catch (e) {
			console.error(`[plugin ${d.plugin}] drop ${d.id} failed:`, e instanceof Error ? e.message : e);
		}
	}
	return false;
}

/** Is there a plugin target for these paths (the drop hint)? */
export function hasDropTarget(target: DropRegistration["target"], paths: string[]): DropRegistration | undefined {
	return registries.dropTargets.list().find((d) => matches(d.reg, target, paths))?.reg;
}
