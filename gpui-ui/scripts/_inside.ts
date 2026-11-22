// Is a path inside a folder? Used by release.ts to keep the signing key out of the repository.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The path with every link in it resolved, as far as it exists (a folder about to be created is resolved from its nearest parent). */
function real(p: string): string {
	const abs = resolve(p);
	const rest: string[] = [];
	let at = abs;
	while (!existsSync(at)) {
		const up = dirname(at);
		if (up === at) return abs;
		rest.unshift(at.slice(up.length).replace(/^[\\/]+/, ""));
		at = up;
	}
	return join(realpathSync.native(at), ...rest);
}

/** True when `p` is `root` or lies under it, links resolved. A name that merely starts with two dots ("..keys") is inside. */
export function isInside(root: string, p: string): boolean {
	const r = relative(real(root), real(p));
	return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
