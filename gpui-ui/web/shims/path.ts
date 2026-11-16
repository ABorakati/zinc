// node:path for the browser demo: forward-slash paths, accepting backslashes and drive letters as the Windows app's code builds them.
const norm = (s: string) => s.replace(/\\/g, "/");
export const sep = "/";
export const delimiter = ";";
export function normalize(p: string): string {
	const s = norm(p);
	const abs = s.startsWith("/");
	const out: string[] = [];
	for (const part of s.split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
		else out.push(part);
	}
	return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
export const join = (...parts: string[]) => normalize(parts.filter(Boolean).map(norm).join("/"));
export const isAbsolute = (p: string) => /^([a-zA-Z]:)?[\\/]/.test(p);
export const resolve = (...parts: string[]) => {
	let r = "";
	for (const p of parts) if (p) r = isAbsolute(p) ? p : r ? `${r}/${p}` : p;
	return normalize(isAbsolute(r) ? r : `/${r}`);
};
export const dirname = (p: string) => {
	const s = norm(p).replace(/\/+$/, "");
	const i = s.lastIndexOf("/");
	return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i);
};
export const basename = (p: string, ext?: string) => {
	const b = norm(p).replace(/\/+$/, "").split("/").pop() ?? "";
	return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname = (p: string) => {
	const b = basename(p);
	const i = b.lastIndexOf(".");
	return i <= 0 ? "" : b.slice(i);
};
export const relative = (from: string, to: string) => {
	const a = resolve(from).split("/").filter(Boolean),
		b = resolve(to).split("/").filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i]!.toLowerCase() === b[i]!.toLowerCase()) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};
export const parse = (p: string) => ({
	root: isAbsolute(p) ? "/" : "",
	dir: dirname(p),
	base: basename(p),
	ext: extname(p),
	name: basename(p, extname(p)),
});
export const format = (o: { dir?: string; base?: string }) => join(o.dir ?? "", o.base ?? "");
const api = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format };
export const posix = api;
export const win32 = api;
export default api;
