// Types for the vendored JavaScript the browser build imports directly (web/structure-load.ts).
declare module "*/structured-document-text/src/pack/reader.js" {
	export function openStructuredDocumentTextPack(input: Uint8Array, options: { inflate(bytes: Uint8Array): Uint8Array }): Promise<{ materialize(): Promise<unknown> }>;
}
// core/src/fulltext/wasm.ts imports its engine as a file (`with { type: "file" }`): the default export is the file's path or URL
declare module "*.wasm" {
	const path: string;
	export default path;
}
