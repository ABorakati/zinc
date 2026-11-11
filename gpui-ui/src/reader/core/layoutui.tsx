// The reader's View menu (scroll mode, spreads, Rotate Pages, Delete Pages, Print), the thumbnails' right-click menu and the
// commands behind them. Rotate / Delete change the PDF FILE as Zotero does (core/pageops.ts); Print shows the system print dialog
// and prints through PDFium (pdf.ts printPdf, native/pdf/src/ops.rs).
import { createSignal, type Accessor, type JSX } from "solid-js";
import type { Mode, Style } from "../../contracts";
import { Icon } from "../../icons";
import { tokens, tw } from "../../theme";
import { confirm } from "../../ui/dialogs";
import { DropdownMenu, openMenu } from "../../ui/menu";
import { toast } from "../../ui/overlay";
import type { MenuItem } from "../../ui/core";
import { pdfOpsUnavailable, printPdf, type PdfDoc } from "../pdf";
import type { ScrollMode, SpreadMode } from "./layout";
import { deletePages, rotatePages } from "./pageops";

export interface PageCmdHost {
	attachmentKey(): string;
	/** a file the reader opened by path (scripts) */
	path(): string | undefined;
	title(): string;
	doc: Accessor<PdfDoc | null>;
	curPage(): number;
	/** pages picked in the thumbnails (empty: none) */
	selected(): number[];
	/** the file's bytes as they are now */
	read(): Promise<Uint8Array>;
	/** false when the reader shows a document it does not own (a script's PdfDoc) */
	canEdit(): boolean;
	/** true when the attachment's library does not let this user change files (a read-only group) */
	filesLocked?(): boolean;
	reopen(map: (page: number) => number): Promise<void>;
}

/** "page 3", "pages 3-5 and 8" (1-based, for messages) */
export function describePages(pages: number[]): string {
	const ps = [...new Set(pages)].sort((a, b) => a - b);
	const runs: string[] = [];
	for (let k = 0; k < ps.length; ) {
		let j = k;
		while (j + 1 < ps.length && ps[j + 1] === ps[j]! + 1) j++;
		runs.push(j > k ? `${ps[k]! + 1}–${ps[j]! + 1}` : String(ps[k]! + 1));
		k = j + 1;
	}
	const list = runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}` : runs[0] ?? "";
	return `${ps.length === 1 ? "page" : "pages"} ${list}`;
}

export function createPageCommands(h: PageCmdHost) {
	const [busy, setBusy] = createSignal<null | "rotate" | "delete" | "print">(null);
	/** what Rotate / Delete act on: the given pages, else the pages picked in the thumbnails, else the current page */
	const targets = (pages?: number[]): number[] => (pages?.length ? pages : h.selected().length ? h.selected() : [h.curPage()]);
	/** why the file cannot be changed now (null: it can) */
	const editBlocked = (): string | null => (!h.doc() ? "No document is open." : !h.canEdit() ? "This document was opened by a script and cannot be changed." : h.filesLocked?.() ? "This library is read-only, so its files cannot be changed." : pdfOpsUnavailable());
	const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: e instanceof Error ? e.message : String(e) });
	const target = () => ({
		attachmentKey: h.attachmentKey(), path: h.path(), pageCount: h.doc()?.pageCount ?? 0,
		read: h.read, reopen: h.reopen,
	});

	async function rotate(turns: number, pages?: number[]): Promise<void> {
		const why = editBlocked();
		if (why) { toast("The pages cannot be rotated", { kind: "error", description: why }); return; }
		if (busy()) return;
		const ps = targets(pages);
		setBusy("rotate");
		try {
			await rotatePages(target(), ps, turns);
			toast(`Rotated ${describePages(ps)} ${turns > 0 ? "right" : "left"}`, { kind: "success", description: "The change is saved in the PDF file.", id: "reader-pageop" });
		} catch (e) { fail("The pages could not be rotated", e); } finally { setBusy(null); }
	}

	async function remove(pages?: number[], ask = true): Promise<void> {
		const why = editBlocked();
		if (why) { toast("The pages cannot be deleted", { kind: "error", description: why }); return; }
		if (busy()) return;
		const ps = [...new Set(targets(pages))].sort((a, b) => a - b);
		const n = h.doc()?.pageCount ?? 0;
		if (ps.length >= n) { toast("The pages cannot be deleted", { kind: "error", description: "A PDF must keep at least one page." }); return; }
		if (ask) {
			const ok = await confirm({
				title: ps.length === 1 ? "Delete this page?" : `Delete ${ps.length} pages?`,
				body: `${describePages(ps).replace(/^p/, "P")} will be removed from the PDF file, together with any annotations on ${ps.length === 1 ? "it" : "them"}. This cannot be undone.`,
				confirmLabel: ps.length === 1 ? "Delete Page" : "Delete Pages",
				danger: true,
			});
			if (!ok) return;
		}
		setBusy("delete");
		try {
			await deletePages(target(), ps);
			toast(`Deleted ${describePages(ps)}`, { kind: "success", description: "The change is saved in the PDF file.", id: "reader-pageop" });
		} catch (e) { fail("The pages could not be deleted", e); } finally { setBusy(null); }
	}

	async function print(): Promise<void> {
		if (busy() || !h.doc()) return;
		const why = pdfOpsUnavailable();
		if (why) { toast("Printing is not available", { kind: "error", description: why }); return; }
		setBusy("print");
		try {
			const r = await printPdf(await h.read(), { title: h.title() || "PDF", currentPage: h.curPage() });
			// Linux's print dialog does not say which pages or printer were chosen (pages 0)
			if (r.result === "printed") toast(r.pages ? `Sent ${r.pages} page${r.pages === 1 ? "" : "s"} to ${r.printer || "the printer"}` : `Sent to ${r.printer || "the printer"}`, { kind: "success" });
		} catch (e) { fail("The document could not be printed", e); } finally { setBusy(null); }
	}

	/** Rotate Left / Right and Delete for `pages` (or the default targets) */
	function pageItems(pages?: () => number[]): MenuItem[] {
		const ps = pages ? pages() : targets();
		const n = ps.length, many = n > 1 ? `${n} Pages` : "Page";
		const off = !!busy() || !!editBlocked();
		return [
			{ heading: n > 1 ? `${n} pages (changes the PDF file)` : `Page ${(ps[0] ?? 0) + 1} (changes the PDF file)` },
			{ label: `Rotate ${many} Left`, icon: "rotate-ccw-square", disabled: off, onSelect: () => void rotate(-1, ps) },
			{ label: `Rotate ${many} Right`, icon: "rotate-cw-square", disabled: off, onSelect: () => void rotate(1, ps) },
			{ label: `Delete ${many}…`, icon: "trash-2", danger: true, disabled: off || n >= (h.doc()?.pageCount ?? 0), onSelect: () => void remove(ps) },
		];
	}

	/** right-click on a thumbnail: a page outside the selection becomes the selection (as in Zotero), then the page commands */
	function thumbMenu(page: number, x: number, y: number, sel: Accessor<number[]>, setSel: (p: number[]) => void): void {
		const s = sel();
		const inSel = s.length ? s.includes(page) : page === h.curPage();
		if (!inSel) setSel([page]);
		const ps = inSel ? (s.length ? s : [page]) : [page];
		openMenu({ x, y }, () => pageItems(() => ps));
	}

	return { busy, rotate, remove, print, pageItems, thumbMenu, targets };
}
export type PageCommands = ReturnType<typeof createPageCommands>;

// ------------------------------------------------------------------------------------------------ toolbar

function ToolButton(p: { icon: string; title: string; mode: Accessor<Mode>; on?: boolean; disabled?: boolean; onClick?: () => void; chevron?: boolean; testId?: string }): JSX.Element {
	const t = (cls: string): Style => tw(cls, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	return (
		<div
			aria-label={p.title}
			testId={p.testId}
			onClick={() => { if (!p.disabled) p.onClick?.(); }}
			style={{
				...t(`flex h-8 ${p.chevron ? "px-1.5 gap-0.5" : "w-8"} flex-none items-center justify-center rounded-md`),
				cursor: p.disabled ? "default" : "pointer",
				...(p.on ? { backgroundColor: tok("accent") } : {}),
				hover: p.disabled ? {} : t("bg-accent"),
			}}
		>
			<Icon name={p.icon} size={16} color={tok(p.disabled ? "border" : p.on ? "foreground" : "muted-foreground")} />
			{p.chevron ? <Icon name="chevron-down" size={12} color={tok("muted-foreground")} /> : undefined}
		</div>
	);
}

const SCROLL_ITEMS: { id: ScrollMode; label: string; icon: string }[] = [
	{ id: "vertical", label: "Vertical Scrolling", icon: "gallery-vertical" },
	{ id: "horizontal", label: "Horizontal Scrolling", icon: "gallery-horizontal" },
	{ id: "wrapped", label: "Wrapped Scrolling", icon: "layout-grid" },
];
const SPREAD_ITEMS: { id: SpreadMode; label: string }[] = [
	{ id: "none", label: "No Spreads" },
	{ id: "odd", label: "Odd Spreads" },
	{ id: "even", label: "Even Spreads" },
];

/** The View menu: scroll mode and spreads (per document), the page commands, Print. */
export function ViewMenuButton(p: {
	mode: Accessor<Mode>;
	scroll: Accessor<ScrollMode>;
	spread: Accessor<SpreadMode>;
	setLayout(scroll?: ScrollMode, spread?: SpreadMode): void;
	cmds: PageCommands;
}): JSX.Element {
	const icon = () => (p.spread() !== "none" ? "book-open" : SCROLL_ITEMS.find((s) => s.id === p.scroll())?.icon ?? "gallery-vertical");
	const items = (): MenuItem[] => [
		{ heading: "Scrolling" },
		...SCROLL_ITEMS.map((s): MenuItem => ({ label: s.label, checked: p.scroll() === s.id, onSelect: () => p.setLayout(s.id, undefined) })),
		{ separator: true },
		{ heading: "Spreads" },
		...SPREAD_ITEMS.map((s): MenuItem => ({ label: s.label, checked: p.spread() === s.id, onSelect: () => p.setLayout(undefined, s.id) })),
		{ separator: true },
		...p.cmds.pageItems(),
		{ separator: true },
		{ label: "Print…", icon: "printer", shortcut: "Ctrl+P", disabled: !!p.cmds.busy(), onSelect: () => void p.cmds.print() },
	];
	return <DropdownMenu trigger={<ToolButton icon={icon()} title="View: page layout, rotate and delete pages, print" mode={p.mode} chevron testId="reader-view-menu" />} items={items} width={240} />;
}

export function PrintButton(p: { mode: Accessor<Mode>; cmds: PageCommands }): JSX.Element {
	return <ToolButton icon="printer" title="Print (Ctrl+P)" mode={p.mode} disabled={p.cmds.busy() === "print"} onClick={() => void p.cmds.print()} />;
}
