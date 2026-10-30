// The only place that touches vendor/ (read-only). Imported by relative path: structured-document-text is
// Zotero's own library, pako is the inflate implementation Zotero's reader pairs it with.
// @ts-expect-error untyped JS
import { openStructuredDocumentTextPack } from "../../../vendor/reader/structured-document-text/src/pack/reader.js";
// @ts-expect-error untyped JS
import { SDT_PACK_VERSION, SDT_SCHEMA_VERSION } from "../../../vendor/reader/structured-document-text/src/version.js";
// @ts-expect-error untyped CommonJS
import * as inflateLib from "../../../vendor/reader/node_modules/pako/lib/inflate.js";

export { SDT_PACK_VERSION, SDT_SCHEMA_VERSION };

export interface PackReader {
	materialize(): Promise<unknown>;
}

const inflateRaw: (b: Uint8Array) => Uint8Array = (inflateLib as any).inflateRaw ?? (inflateLib as any).default?.inflateRaw;

export function openPack(bytes: ArrayBuffer | Uint8Array): Promise<PackReader> {
	return openStructuredDocumentTextPack(bytes, { inflate: (b: Uint8Array) => inflateRaw(b) });
}
