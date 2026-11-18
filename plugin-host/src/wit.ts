// A small reader for the zinc:plugin WIT files: which functions does each interface have? Used by the build pipeline to derive
// the jco `--async-imports` / `--async-exports` lists, so they never get typed by hand. It relies on the layout the files use:
// `interface name {` at the top level, function items `name: func(` at brace depth 1, and `resource name {` blocks at depth 1 whose
// functions (and `constructor(`) are at depth 2. Resource functions get jco's names: `[method]body-reader.read`, `[constructor]file-writer`.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** interface name (kebab, no package) -> function names (kebab; resource functions in jco's `[method]res.fn` form). */
export type InterfaceFunctions = Map<string, string[]>;

export function parseInterfaceFunctions(source: string, into: InterfaceFunctions = new Map()): InterfaceFunctions {
	const funcLine = /^\s*([a-z][a-z0-9-]*)\s*:\s*(?:async\s+)?func\s*\(/;
	let depth = 0;
	let current: string | undefined;
	let resource: string | undefined;
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.replace(/\/\/.*$/, "");
		if (depth === 0) {
			const m = /^\s*interface\s+([a-z][a-z0-9-]*)\s*\{/.exec(line);
			if (m) {
				current = m[1];
				if (!into.has(current)) into.set(current, []);
			}
		} else if (depth === 1 && current) {
			const r = /^\s*resource\s+([a-z][a-z0-9-]*)\s*\{/.exec(line);
			if (r) resource = r[1];
			const m = funcLine.exec(line);
			if (m) into.get(current)!.push(m[1]);
		} else if (depth === 2 && current && resource) {
			const m = funcLine.exec(line);
			if (m) into.get(current)!.push(`[method]${resource}.${m[1]}`);
			else if (/^\s*constructor\s*\(/.test(line)) into.get(current)!.push(`[constructor]${resource}`);
		}
		for (const ch of line) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
		if (depth <= 1) {
			if (depth === 0) current = undefined;
			// a resource block ends when depth is back to 1 on a line that does not open one
			if (!/^\s*resource\s/.test(line)) resource = undefined;
		}
	}
	return into;
}

export async function readInterfaceFunctions(witDir: string): Promise<InterfaceFunctions> {
	const out: InterfaceFunctions = new Map();
	for (const f of (await readdir(witDir)).filter((f) => f.endsWith(".wit")).sort()) {
		parseInterfaceFunctions(await Bun.file(join(witDir, f)).text(), out);
	}
	return out;
}

/** From the text `jco wit` / `componentWit` prints for a component: the zinc:plugin interfaces it imports and exports. */
export function worldInterfaces(witText: string): { imports: string[]; exports: string[] } {
	const imports: string[] = [];
	const exports: string[] = [];
	for (const m of witText.matchAll(/^\s*(import|export)\s+zinc:plugin\/([a-z][a-z0-9-]*)(?:@[^;]+)?;/gm)) {
		(m[1] === "import" ? imports : exports).push(m[2]);
	}
	return { imports, exports };
}

/** The jco option lists for one component. Interfaces with no functions (`types`) contribute nothing. */
export function asyncLists(fns: InterfaceFunctions, world: { imports: string[]; exports: string[] }) {
	const list = (ifaces: string[]) =>
		ifaces.flatMap((i) => {
			const f = fns.get(i);
			if (!f) throw new Error(`component uses zinc:plugin/${i}, which the WIT files do not define`);
			return f.filter((name) => !name.startsWith("[constructor]")).map((name) => `zinc:plugin/${i}#${name}`); // a JS `new` cannot wait: constructors stay sync
		});
	return { asyncImports: list(world.imports), asyncExports: list(world.exports) };
}
