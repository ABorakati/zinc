// annotations plugin (reader-next/src/annotations): highlight/underline from the current selection (selection popup with
// colours), sticky notes, the annotations side panel (list, colour filter, comments, delete) and page overlays drawing the saved
// annotations. Storage is the core's annotations API (Zotero reader JSON), so the web reader and Zotero see the same annotations.
import { Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import type { ReaderContext, ReaderPlugin } from "../plugins";
import { IconButton, Swatches, kit } from "../structure/kit";
import { PageAnnotations } from "./PageOverlay";
import { AnnotationsPanel } from "./Panel";
import { COLORS } from "./model";
import { closeSession, sessionFor } from "./session";

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
			<Show when={label}><text style={{ ...k.tx("text-xs text-foreground"), whiteSpace: "nowrap" }}>{label!}</text></Show>
		</div>
	);
	return (
		<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, userSelect: "none" }}>
			<div style={{ width: 1, height: 18, backgroundColor: k.tok("border"), marginLeft: 2, marginRight: 4 }} />
			<Swatches k={k} colors={COLORS} value={s.ui.color()} size={16} onPick={(c) => make("highlight", c)} />
			<div style={{ width: 1, height: 18, backgroundColor: k.tok("border"), marginLeft: 4, marginRight: 2 }} />
			{action("Highlight", "highlighter", () => make("highlight"))}
			{action("Underline", "underline", () => make("underline"))}
			{action(undefined, "message-square-plus", () => make("highlight", s.ui.color(), true))}
		</div>
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
	return (
		<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 2 }}>
			{tools.map((t) => (
				<IconButton k={k} icon={t.icon} title={t.title} on={s.ui.tool() === t.id} onClick={() => s.ui.setTool(s.ui.tool() === t.id ? null : t.id)} />
			))}
			<Show when={s.ui.tool() && s.ui.tool() !== "eraser"}>
				<div style={{ marginLeft: 6 }}>
					<Swatches k={k} colors={COLORS} value={s.ui.color()} size={14} onPick={(c) => s.ui.setColor(c)} />
				</div>
			</Show>
			<Show when={s.ui.tool() === "ink"}>
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 6 }}>
					{widths.map((w) => {
						const isSel = () => (s.ui.inkWidth?.() ?? 2) === w;
						return (
							<div
								onClick={() => s.ui.setInkWidth?.(w)}
								style={{
									...k.t("flex items-center justify-center rounded border"),
									width: 22, height: 20, cursor: "pointer",
									borderColor: isSel() ? k.tok("primary") : k.tok("input"),
									backgroundColor: isSel() ? k.tok("accent") : "transparent",
								}}
							>
								<div style={{ width: 12, height: w, backgroundColor: k.tok("foreground"), borderRadius: w / 2 }} />
							</div>
						);
					})}
				</div>
			</Show>
		</div>
	);
}

export const annotationsPlugin: ReaderPlugin = {
	id: "annotations",
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
