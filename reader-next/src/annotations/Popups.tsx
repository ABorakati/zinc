// Floating UI: the popup after selecting text, the popup of a selected annotation, the tool colour bar, a toast.
import { Copy, Highlighter, MessageSquarePlus, Trash, Underline } from "lucide-solid";
import { createMemo, Show } from "solid-js";
import type { Ctx } from "./actions";
import { boundingRect, type Annotation } from "./model";
import { CommentBox, Swatches, TagEditor } from "./Widgets";
import { Button } from "../viewer/ui/button";
import { cn } from "../viewer/ui/utils";

const POP_W = 300;
const clampLeft = (center: number, w = POP_W) => Math.max(8, Math.min(center - w / 2, window.innerWidth - w - 8));
const iconBtn = "h-7 gap-1 px-2 text-[12px]";

function SelectionPopup(props: { ctx: Ctx }) {
	const { ui, act, viewer } = props.ctx;
	const sel = () => (!ui.tool() && !ui.dragging() ? ui.selection() : null);
	const style = () => {
		const b = sel()!.bounds;
		const below = b.bottom + 10 + 74 < window.innerHeight;
		return { left: `${clampLeft((b.left + b.right) / 2, 270)}px`, top: below ? `${b.bottom + 10}px` : `${Math.max(48, b.top - 112)}px` };
	};
	const make = (type: "highlight" | "underline", color = ui.color(), comment = false) => {
		ui.setColor(color);
		void act.fromSelection(type, color, { comment });
	};
	return (
		<Show when={sel()}>
			<div
				data-rn-ann-ui="selection" class="fixed z-40 w-[270px] select-none rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
				style={style()} onMouseDown={(e) => e.preventDefault()}
			>
				<Swatches value={ui.color()} onPick={(c) => make("highlight", c)} />
				<div class="mt-2 flex items-center gap-0.5">
					<Button variant="ghost" class={iconBtn} title="Highlight" onClick={() => make("highlight")}><Highlighter class="size-3.5" />Highlight</Button>
					<Button variant="ghost" class={iconBtn} title="Underline" onClick={() => make("underline")}><Underline class="size-3.5" />Underline</Button>
					<Button variant="ghost" class={iconBtn} title="Copy" onClick={() => {
						const t = viewer.selection()?.text;
						if (t) void navigator.clipboard.writeText(t).catch(() => {});
						viewer.clearSelection();
					}}><Copy class="size-3.5" />Copy</Button>
				</div>
				<Button variant="ghost" class={cn(iconBtn, "mt-0.5 w-full justify-start")} title="Highlight and add a comment" onClick={() => make("highlight", ui.color(), true)}>
					<MessageSquarePlus class="size-3.5" />Add comment
				</Button>
			</div>
		</Show>
	);
}

function AnnotationPopup(props: { ctx: Ctx }) {
	const { ui, store, act, viewer } = props.ctx;
	const ann = createMemo<Annotation | undefined>(() => { const id = ui.selectedId(); return id ? store.get(id) : undefined; });
	// where the annotation is on screen (window px); recomputed when the view moves
	const anchor = () => {
		ui.tick();
		const a = ann();
		if (!a) return null;
		const b = a.position.rects?.length ? boundingRect({ pageIndex: a.position.pageIndex, rects: a.position.rects }) : boundingRect(a.position);
		const r = viewer.rectToClient(a.position.pageIndex, b);
		if (!r || r.bottom < 44 || r.top > window.innerHeight) return null;
		return r;
	};
	const style = () => {
		const r = anchor()!;
		const below = r.bottom + 12 + 190 < window.innerHeight;
		return below
			? { left: `${clampLeft((r.left + r.right) / 2)}px`, top: `${r.bottom + 8}px` }
			: { left: `${clampLeft((r.left + r.right) / 2)}px`, top: `${Math.max(48, r.top - 8)}px`, transform: "translateY(-100%)" };
	};
	return (
		<Show when={ann() && anchor()}>
			<div
				data-rn-ann-ui="annotation" class="fixed z-40 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg"
				style={{ ...style(), width: `${POP_W}px` }}
			>
				<div class="flex items-center justify-between gap-2">
					<Swatches value={ann()!.color} onPick={(c) => { ui.setColor(c); store.update(ann()!.id, { color: c }); }} />
					<Button variant="ghost" class="size-7 p-0 text-muted-foreground hover:text-destructive" title="Delete (Del)" aria-label="Delete annotation" onClick={() => act.remove([ann()!.id])}>
						<Trash class="size-4" />
					</Button>
				</div>
				<Show when={ann()!.text}>
					<p class="mt-2 line-clamp-3 border-l-2 pl-2 text-[12px] italic text-muted-foreground" style={{ "border-color": ann()!.color }}>{ann()!.text}</p>
				</Show>
				<div class="mt-2"><CommentBox ctx={props.ctx} id={ann()!.id} /></div>
				<div class="mt-1.5 rounded border px-1.5 py-1"><TagEditor ctx={props.ctx} id={ann()!.id} /></div>
			</div>
		</Show>
	);
}

const TOOL_NAMES = { highlight: "Highlight", underline: "Underline", note: "Note: click to place", image: "Area: drag a rectangle", ink: "Ink: draw" } as const;

function ToolBar(props: { ctx: Ctx }) {
	const { ui } = props.ctx;
	return (
		<Show when={ui.tool()}>
			{(t) => (
				<div data-rn-ann-ui="tools" class="fixed left-1/2 top-12 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border bg-popover px-3 py-1.5 text-[12px] shadow-md">
					<span class="font-medium">{TOOL_NAMES[t()]}</span>
					<Swatches value={ui.color()} onPick={(c) => ui.setColor(c)} size="sm" />
					<button class="text-muted-foreground hover:text-foreground" onClick={() => ui.setTool(null)} title="Done (Esc)">Done</button>
				</div>
			)}
		</Show>
	);
}

export function Popups(props: { ctx: Ctx }) {
	const { ui } = props.ctx;
	return (
		<>
			<ToolBar ctx={props.ctx} />
			<SelectionPopup ctx={props.ctx} />
			<AnnotationPopup ctx={props.ctx} />
			<Show when={ui.toast()}>
				{(m) => <div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-[12.5px] shadow-lg" role="status">{m()}</div>}
			</Show>
		</>
	);
}
