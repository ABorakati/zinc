// annotations plugin (reader-next/src/annotations): highlight/underline from the current selection (selection popup with
// colours), sticky notes, the annotations side panel (list, colour filter, comments, delete) and page overlays drawing the saved
// annotations. Storage is the core's annotations API (Zotero reader JSON), so the web reader and Zotero see the same annotations.
import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import { Icon } from "../../icons";
import { Popover } from "../../ui";
import { boundsOf, type Anchor } from "../../ui/core";
import { pluginMenuItems, type ReaderContext, type ReaderPlugin } from "../plugins";
import { IconButton, Swatches, kit } from "../structure/kit";
import { PageAnnotations } from "./PageOverlay";
import { AnnotationsPanel } from "./Panel";
import { COLORS } from "./model";
import { closeSession, sessionFor, type Tool } from "./session";

function SelectionPopup(p: { ctx: ReaderContext }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const make = (type: "highlight" | "underline", color = s.ui.color(), comment = false) => {
		s.ui.setColor(color);
		void s.act.fromSelection(type, color, { comment });
	};
	// the reader core puts a Copy button first and our controls after it, in one row: a colour palette and three actions
	const action = (label: string | undefined, icon: string, run: () => void): JSX.Element => (
		<div
			onClick={run}
			style={{ ...k.t("flex flex-row items-center rounded-md px-2"), height: 28, gap: 5, cursor: "pointer", hover: k.t("bg-accent") }}
		>
			<Icon name={icon} size={14} color={k.tok("foreground")} />
			<Show when={label}>
				<text style={{ ...k.tx("text-xs text-foreground"), whiteSpace: "nowrap" }}>{label!}</text>
			</Show>
		</div>
	);
	return (
		<Show when={!p.ctx.readOnly}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, userSelect: "none" }}>
				<div style={{ width: 1, height: 18, backgroundColor: k.tok("border"), marginLeft: 2, marginRight: 4 }} />
				<Swatches k={k} colors={COLORS} value={s.ui.color()} size={16} onPick={(c) => make("highlight", c)} />
				<div style={{ width: 1, height: 18, backgroundColor: k.tok("border"), marginLeft: 4, marginRight: 2 }} />
				{action("Highlight", "highlighter", () => make("highlight"))}
				{action("Underline", "underline", () => make("underline"))}
				{action(undefined, "message-square-plus", () => make("highlight", s.ui.color(), true))}
			</div>
		</Show>
	);
}

function Toolbar(p: { ctx: ReaderContext }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const tools = [
		{ id: "highlight", icon: "highlighter", title: "Highlight text" },
		{ id: "underline", icon: "underline", title: "Underline text" },
		{ id: "note", icon: "message-square-text", title: "Add note (click on the page)" },
		{ id: "ink", icon: "pen-line", title: "Draw ink" },
		{ id: "eraser", icon: "eraser", title: "Eraser (remove ink)" },
	] as const;
	const widths = [1, 2, 4];
	// A tool's options (colour, ink thickness) live behind ONE small button that opens a popover, like Zotero's colour picker, so
	// selecting a tool adds 44 px to the toolbar instead of a palette of eight swatches plus three sizes.
	const hasOptions = () => !!s.ui.tool() && s.ui.tool() !== "eraser";
	const [open, setOpen] = createSignal(false);
	const [anchor, setAnchor] = createSignal<Anchor>({ x: 0, y: 0 });
	let trigger: HostElement | undefined;
	createEffect(() => {
		if (!hasOptions()) setOpen(false);
	});
	const toggle = (e: { x?: number; y?: number }) => {
		if (open()) {
			setOpen(false);
			return;
		}
		const r = boundsOf(trigger);
		setAnchor(r ? { rect: r, align: "start" } : { x: e.x ?? 0, y: e.y ?? 0 });
		setOpen(true);
	};
	/** the plugins' createColorContextMenu items: plain rows (submenus and separators are not drawn here) */
		const colorRows = () => pluginMenuItems((pl) => pl.colorMenu?.(p.ctx)).filter((it) => it.onSelect && it.label);
		const label = (text: string) => (
		<text style={{ ...k.tx("text-xs font-medium text-muted-foreground"), whiteSpace: "nowrap" }}>{text}</text>
	);
	return (
		<Show
			when={!p.ctx.readOnly}
			fallback={
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
					<Icon name="lock" size={13} color={k.tok("muted-foreground")} />
					<text style={{ ...k.tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>Read-only library</text>
				</div>
			}
		>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
				{tools.map((t) => (
					<IconButton
						k={k}
						icon={t.icon}
						title={t.title}
						on={s.ui.tool() === t.id}
						onClick={() => s.ui.setTool(s.ui.tool() === t.id ? null : t.id)}
					/>
				))}
				<Show when={hasOptions()}>
					<div
						ref={(x: HostElement) => {
							trigger = x;
						}}
						style={{
							...k.t("relative flex flex-none flex-row items-center rounded-md"),
							height: 28,
							paddingLeft: 6,
							paddingRight: 4,
							gap: 4,
							marginLeft: 4,
							cursor: "pointer",
							...(open() ? { backgroundColor: k.tok("accent") } : {}),
							hover: k.t("bg-accent"),
						}}
					>
						<div
							style={{
								width: 16,
								height: 16,
								borderRadius: 8,
								flexShrink: 0,
								backgroundColor: s.ui.color(),
								borderWidth: 1,
								borderColor: "rgba(0, 0, 0, 0.25)",
							}}
						/>
						<Icon name="chevron-down" size={12} color={k.tok("muted-foreground")} />
						{/* the click is taken by a transparent layer over the trigger, not by the trigger: a filled child (the swatch) would block it (see DropdownMenu) */}
						<div
							onClick={toggle}
							style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none" }}
						/>
					</div>
					<Popover open={open()} onClose={() => setOpen(false)} anchor={anchor()} width={232}>
						<div style={{ display: "flex", flexDirection: "column", gap: 8, userSelect: "none" }}>
							{label("Colour")}
							<Swatches
								k={k}
								colors={COLORS}
								value={s.ui.color()}
								size={20}
								onPick={(c) => {
									s.ui.setColor(c);
									setOpen(false);
								}}
							/>
							{/* Zotero's createColorContextMenu: rows a plugin adds under the swatches */}
								<For each={colorRows()}>
									{(it) => (
										<div
											onClick={() => {
												setOpen(false);
												it.onSelect?.();
											}}
											style={{
												...k.t("flex flex-row items-center rounded px-2"),
												height: 26,
												gap: 6,
												cursor: "pointer",
												hover: k.t("bg-accent"),
											}}
										>
											<Show when={it.iconColor}>
												<div style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: it.iconColor }} />
											</Show>
											<text style={{ ...k.tx("text-xs text-foreground"), whiteSpace: "nowrap" }}>{it.label ?? ""}</text>
										</div>
									)}
								</For>
								<Show when={s.ui.tool() === "ink"}>
								{label("Thickness")}
								<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
									{widths.map((w) => {
										const isSel = () => (s.ui.inkWidth?.() ?? 2) === w;
										return (
											<div
												onClick={() => {
													s.ui.setInkWidth?.(w);
													setOpen(false);
												}}
												style={{
													...k.t("flex items-center justify-center rounded border"),
													width: 36,
													height: 28,
													cursor: "pointer",
													borderColor: isSel() ? k.tok("primary") : k.tok("input"),
													backgroundColor: isSel() ? k.tok("accent") : "transparent",
													hover: k.t("bg-accent"),
												}}
											>
												<div
													style={{
														width: 18,
														height: w,
														backgroundColor: k.tok("foreground"),
														borderRadius: w / 2,
													}}
												/>
											</div>
										);
									})}
								</div>
							</Show>
						</div>
					</Popover>
				</Show>
			</div>
		</Show>
	);
}

// Zotero 7's reader shortcuts for the tools Zinc has. Missing here on purpose (no such feature): text / area tools (Alt+4/5, Ctrl+Alt+4/5),
// hand tool (H), undo / redo of annotation edits, select-all annotations, arrow-key move / resize of an annotation.
const TOOL_KEYS: Record<string, Tool> = { "1": "highlight", "2": "underline", "3": "note", "6": "ink", "7": "eraser" };

function onKey(ctx: ReaderContext, e: Parameters<NonNullable<ReaderPlugin["onKey"]>>[1]): boolean {
	const s = sessionFor(ctx);
	const m = e.modifiers;
	const mod = m.ctrl || m.cmd;
	const k = e.key;
	if (ctx.readOnly) return false;
	// the next colour of the palette: Alt+8 in a PDF; the reading view (Zotero's EPUB) has only three tools, so Alt+4 does it there
	const cycle = () => {
		const i = COLORS.findIndex((c) => c.value === s.ui.color());
		s.ui.setColor(COLORS[(i + 1) % COLORS.length]!.value);
	};
	if (m.alt && !m.shift) {
		if (mod) {
			// Ctrl+Alt+1 / 2: highlight / underline the selected text (Ctrl+Alt+3, a note on the selection, has no counterpart here)
			if ((k === "1" || k === "2") && ctx.selection()) {
				void s.act.fromSelection(k === "1" ? "highlight" : "underline", s.ui.color());
				return true;
			}
			return false;
		}
		if (k === "8" || (k === "4" && ctx.altView())) {
			cycle();
			return true;
		}
		const t = TOOL_KEYS[k];
		// ink / eraser draw on the pages: not offered in the reading view
		if (t && !(ctx.altView() && (t === "ink" || t === "eraser"))) {
			s.ui.setTool(s.ui.tool() === t ? null : t);
			return true;
		}
		return false;
	}
	if (mod || m.alt || !e.onRoot) return false;
	if (k === "escape") {
		if (!s.ui.selectedId()) return false;
		s.ui.select(null);
		return true;
	}
	// 1-8 pick a colour while a tool is active
	if (!m.shift && /^[1-8]$/.test(k) && s.ui.tool() && s.ui.tool() !== "eraser") {
		s.ui.setColor(COLORS[Number(k) - 1]!.value);
		return true;
	}
	if (!m.shift && k === "s") {
		s.ui.setTool(null); // the select tool: no drawing tool active
		return true;
	}
	if (k === "delete" || k === "backspace") {
		const id = s.ui.selectedId();
		if (!id) return false;
		s.act.remove([id]);
		return true;
	}
	return false;
}

export const annotationsPlugin: ReaderPlugin = {
	id: "annotations",
	onKey,
	toolbar: (ctx) => <Toolbar ctx={ctx} />,
	sidePanel: { id: "annotations", label: "Annotations", icon: "highlighter", render: (ctx) => <AnnotationsPanel ctx={ctx} /> },
	pageOverlay: (ctx, page, box) => <PageAnnotations ctx={ctx} page={page} box={box} />,
	selectionPopup: (ctx) => <SelectionPopup ctx={ctx} />,
	onOpen(ctx) {
		const s = sessionFor(ctx);
		void s.store.load().catch(() => {});
		return () => closeSession(ctx.attachmentKey);
	},
};

export { sessionFor, closeSession } from "./session";
