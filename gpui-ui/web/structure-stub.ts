// src/reader/structure/load.ts for a browser build made without vendor/document-worker (web/build.ts picks this when it is missing):
// the reader works and shows "Layout analysis unavailable".
import type { DocStructure } from "../src/reader/structure/types";

export function loadStructure(_attachmentKey: string, _pdfBytes: Uint8Array, _onProgress?: (pct: number) => void): Promise<DocStructure> {
	return Promise.reject(
		new Error("layout analysis is not in this build (vendor/document-worker was missing: bash scripts/build-docworker.sh)"),
	);
}
export function shutdownStructureWorker(): void {}
