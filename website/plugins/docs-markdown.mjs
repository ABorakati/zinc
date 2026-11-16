// Remark plugin: lets docs/ be written as plain GitHub Markdown and still render on the site.
//  - drops the first "# Title" (the page title comes from it, see src/content.config.ts)
//  - turns relative links between docs pages (../user-guide/sync.md#x) into site routes, and FAILS THE BUILD on a broken one
//  - turns relative image paths (../screenshots/x.png) into <base>screenshots/x.png (a missing image only warns)
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");

const BACKSLASH = new RegExp(String.fromCharCode(92, 92), "g");
const fwd = (p) => p.replace(BACKSLASH, "/");

export function normalizeBase(b) {
	let base = b || "/";
	if (!base.startsWith("/")) base = "/" + base;
	if (!base.endsWith("/")) base += "/";
	return base;
}

/** docs-relative file path (with .md) -> the page's slug. README.md is its folder's index. */
export function slugOf(rel) {
	let s = fwd(rel).replace(/\.md$/i, "");
	if (s.toLowerCase() === "readme") return "overview";
	s = s.replace(/\/readme$/i, "");
	return s.toLowerCase();
}

function walk(node, fn) {
	fn(node);
	if (node.children) for (const c of node.children) walk(c, fn);
}

const isAbsoluteUrl = /^([a-z][a-z0-9+.-]*:|#|\/\/)/i;

export function remarkDocs(options = {}) {
	const base = normalizeBase(options.base);
	return (tree, file) => {
		const from = file.path;
		if (!from || !path.resolve(from).startsWith(DOCS_ROOT)) return;
		const dir = path.dirname(from);
		const where = fwd(path.relative(DOCS_ROOT, from));

		const h1 = tree.children.findIndex((n) => n.type === "heading" && n.depth === 1);
		if (h1 >= 0) tree.children.splice(h1, 1);

		walk(tree, (node) => {
			if (node.type === "link" && node.url && !isAbsoluteUrl.test(node.url)) {
				const [rawPath, hash] = node.url.split("#");
				if (!rawPath) return;
				const target = path.resolve(dir, decodeURI(rawPath));
				const frag = hash ? "#" + hash : "";
				if (!target.startsWith(DOCS_ROOT))
					throw new Error(`Link in docs/${where} leaves docs/: ${node.url}. Link inside docs/ only.`);
				let md = null;
				if (/\.md$/i.test(target)) md = target;
				else if (existsSync(target) && statSync(target).isDirectory() && existsSync(path.join(target, "README.md")))
					md = path.join(target, "README.md");
				if (md) {
					if (!existsSync(md)) throw new Error(`Broken link in docs/${where}: ${node.url} (no such file)`);
					node.url = `${base}${slugOf(path.relative(DOCS_ROOT, md))}/${frag}`;
				} else if (existsSync(target)) {
					node.url = base + fwd(path.relative(DOCS_ROOT, target)) + frag;
				} else {
					throw new Error(`Broken link in docs/${where}: ${node.url} (no such file)`);
				}
			}
			if (node.type === "image" && node.url && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(node.url)) {
				const target = path.resolve(dir, decodeURI(node.url));
				if (!target.startsWith(DOCS_ROOT)) throw new Error(`Image in docs/${where} leaves docs/: ${node.url}`);
				if (!existsSync(target)) console.warn(`[docs] image not found (yet): docs/${where} -> ${node.url}`);
				node.url = base + fwd(path.relative(DOCS_ROOT, target));
			}
		});
	};
}
