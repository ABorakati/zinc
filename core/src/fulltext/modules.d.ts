// The built zotero-fulltext WebAssembly core, imported with `with { type: "file" }`
// (Bun embeds it in compiled/bundled apps and resolves to a readable path).
declare module "*.wasm" {
	const path: string;
	export default path;
}
