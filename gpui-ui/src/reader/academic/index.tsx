// academic plugins (reader-next/src/academic): in-text citations / figure and table mentions / supplementary mentions /
// author-year citations with hover and click popovers (a reference card with abstract and "add to library", a figure preview),
// the "Figures & Tables", "References" and "Supplementary" side panels. The document structure comes from Zotero's document
// worker (../structure/load.ts); the bibliography from the core's /api/references.
import type { ReaderPlugin } from "../plugins";
import { AcademicHost, AcademicPage } from "./PageOverlay";
import { FiguresPanel, ReferencesPanel, SupplementaryPanel } from "./Panels";
import { academicFor, closeAcademic } from "./session";

/** Overlay (mentions + citations), the shared popover host and the "back" button. */
export const academicPlugin: ReaderPlugin = {
	id: "academic",
	toolbar: (ctx) => <AcademicHost ctx={ctx} />,
	pageOverlay: (ctx, page, box) => <AcademicPage ctx={ctx} page={page} box={box} />,
	onOpen(ctx) {
		const s = academicFor(ctx);
		// analyse in the background a moment after opening (the document worker is a separate thread), then warm the bibliography
		const t = setTimeout(() => {
			void s.start();
			void s.api.refs().then((r) => s.api.prefetch(r.slice(0, 60)));
		}, 800);
		return () => { clearTimeout(t); closeAcademic(ctx.attachmentKey); };
	},
};

export const figuresPlugin: ReaderPlugin = {
	id: "academic-figures",
	sidePanel: { id: "figures-tables", label: "Figures & Tables", icon: "image", render: (ctx) => <FiguresPanel ctx={ctx} /> },
};

export const referencesPlugin: ReaderPlugin = {
	id: "academic-references",
	sidePanel: { id: "references", label: "References", icon: "quote", render: (ctx) => <ReferencesPanel ctx={ctx} /> },
};

export const supplementaryPlugin: ReaderPlugin = {
	id: "academic-supplementary",
	sidePanel: { id: "supplementary", label: "Supplementary", icon: "paperclip", render: (ctx) => <SupplementaryPanel ctx={ctx} /> },
};

export const academicPlugins: ReaderPlugin[] = [academicPlugin, figuresPlugin, referencesPlugin, supplementaryPlugin];
