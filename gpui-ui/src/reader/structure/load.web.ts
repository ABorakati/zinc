// src/reader/structure/load.ts for the browser builds (web/build.ts uses this file wherever `./load` is imported: the `X.web.ts` rule).
// Layout analysis needs Zotero's document worker (30 MB). When the build has it (web/build.ts defines __ZN_DOCWORKER__: the web page
// always, the extension's library page with --docworker) the real loader is a separate chunk, fetched on the first PDF analysed
// (load.docworker.web.ts). Without it the reader still opens, renders, searches and annotates PDFs. What needs layout analysis says so:
// the reading view shows this message, and the page overlay shows "Layout analysis unavailable"; figure and citation cards fall back to
// what the page text alone gives (captions, numbered references).
import type { DocStructure } from "./types";

/** Defined by web/build.ts. */
declare const __ZN_DOCWORKER__: boolean;

type Real = typeof import("./load.docworker.web");
let real: Promise<Real> | undefined;

export function loadStructure(attachmentKey: string, pdfBytes: Uint8Array, onProgress?: (pct: number) => void): Promise<DocStructure> {
	// (an `if` on the define, so a build without the worker drops the import, and the vendored files it needs, altogether)
	if (__ZN_DOCWORKER__) return (real ??= import("./load.docworker.web")).then((m) => m.loadStructure(attachmentKey, pdfBytes, onProgress));
	return Promise.reject(new Error("The reading view needs layout analysis, which this browser version of Zinc does not include. Open the PDF in the Zinc app to read it in the reading view."));
}

export function shutdownStructureWorker(): void {
	void real?.then((m) => m.shutdownStructureWorker());
}
