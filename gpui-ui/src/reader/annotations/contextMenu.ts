// Context menu definitions for annotations (sidebar list and page overlay).
import type { ReaderContext } from "../plugins";
import type { MenuItem } from "../../ui/core";
import type { Annotation } from "./model";
import { sessionFor } from "./session";
import { copyAnnotationImage, exportAnnotationImage } from "./imageExport";

export interface ContextMenuOpts {
	onExport?: (path: string | null) => void;
	onCopy?: (ok: boolean) => void;
	onDelete?: () => void;
	destDir?: string;
}

/**
 * Return menu items for an annotation's context menu.
 * For image annotations, includes "Copy Image" and "Export Image…".
 */
export function annotationContextMenu(ctx: ReaderContext, a: Annotation, opts: ContextMenuOpts = {}): MenuItem[] {
	const s = sessionFor(ctx);
	const items: MenuItem[] = [];

	if (a.type === "image") {
		items.push({
			label: "Copy Image",
			shortcut: "Ctrl+C",
			onSelect: () => {
				void copyAnnotationImage(ctx, a, s.ui.notify).then((ok) => opts.onCopy?.(ok));
			},
		});
		items.push({
			label: "Export Image…",
			onSelect: () => {
				void exportAnnotationImage(ctx, a, opts.destDir, s.ui.notify).then((p) => opts.onExport?.(p));
			},
		});
		items.push({ separator: true });
	}

	items.push({
		label: "Delete",
		shortcut: "Del",
		onSelect: () => {
			s.act.remove([a.id]);
			opts.onDelete?.();
		},
	});

	return items;
}
