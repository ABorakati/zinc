// src/reader/structure/load.ts for browser builds without Zotero's document worker (web/build.ts picks this when vendor/document-worker
// is missing, and for the connector's library tab unless --docworker is given: it would add 30 MB). The reader still opens, renders,
// searches and annotates PDFs. What needs layout analysis says so: the reading view shows this message, and the page overlay shows
// "Layout analysis unavailable"; figure and citation cards fall back to what the page text alone gives (captions, numbered references).
import type { DocStructure } from "../src/reader/structure/types";

export function loadStructure(_attachmentKey: string, _pdfBytes: Uint8Array, _onProgress?: (pct: number) => void): Promise<DocStructure> {
	return Promise.reject(new Error("The reading view needs layout analysis, which this browser version of Zinc does not include. Open the PDF in the Zinc app to read it in the reading view."));
}
export function shutdownStructureWorker(): void {}
