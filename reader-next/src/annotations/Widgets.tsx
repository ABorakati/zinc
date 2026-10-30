// Small shared pieces: colour swatches, the comment box and the tag editor.
import { createEffect, For, onMount, Show } from "solid-js";
import type { Ctx } from "./actions";
import { COLORS } from "./model";
import { cn } from "../viewer/ui/utils";

export function Swatches(props: { value?: string; onPick: (c: string) => void; size?: "sm" | "md" }) {
	return (
		<div class="flex items-center gap-1" data-swatches>
			<For each={COLORS}>{(c) => (
				<button
					type="button" title={c.name} aria-label={c.name} data-color={c.value}
					class={cn("rounded-full border border-black/20 transition-transform hover:scale-110", props.size === "sm" ? "size-3.5" : "size-5", props.value === c.value && "ring-2 ring-primary ring-offset-1 ring-offset-popover")}
					style={{ "background-color": c.value }}
					onClick={() => props.onPick(c.value)}
				/>
			)}</For>
		</div>
	);
}

/** Textarea bound to an annotation's comment; follows outside edits without moving the caret. */
export function CommentBox(props: { ctx: Ctx; id: string; class?: string; placeholder?: string; rows?: number }) {
	const { store, ui } = props.ctx;
	let el!: HTMLTextAreaElement;
	const grow = () => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`; };
	createEffect(() => {
		const v = store.get(props.id)?.comment ?? "";
		if (el.value !== v) { el.value = v; grow(); }
	});
	onMount(grow);
	createEffect(() => {
		if (ui.focusComment() === props.id) {
			queueMicrotask(() => { el.focus(); ui.setFocusComment(null); });
		}
	});
	return (
		<textarea
			ref={el} rows={props.rows ?? 2} placeholder={props.placeholder ?? "Add comment…"} data-comment={props.id}
			class={cn("w-full resize-none rounded border bg-background px-1.5 py-1 text-[12.5px] leading-snug outline-none focus:ring-2 focus:ring-ring", props.class)}
			onInput={(e) => { grow(); store.update(props.id, { comment: e.currentTarget.value }); }}
			onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") e.currentTarget.blur(); }}
		/>
	);
}

export function TagEditor(props: { ctx: Ctx; id: string }) {
	const { store } = props.ctx;
	const tags = () => store.get(props.id)?.tags ?? [];
	const add = (raw: string) => {
		const names = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
		if (!names.length) return;
		const have = new Set(tags().map((t) => t.name));
		const next = [...tags(), ...names.filter((n, i) => !have.has(n) && names.indexOf(n) === i).map((name) => ({ name }))];
		store.update(props.id, { tags: next });
	};
	return (
		<div class="flex flex-wrap items-center gap-1" data-tags>
			<For each={tags()}>{(t) => (
				<span class="inline-flex items-center gap-0.5 rounded bg-accent px-1.5 py-0.5 text-[11px]">
					{t.name}
					<button type="button" class="text-muted-foreground hover:text-foreground" aria-label={`Remove tag ${t.name}`} onClick={() => store.update(props.id, { tags: tags().filter((x) => x.name !== t.name) })}>×</button>
				</span>
			)}</For>
			<input
				placeholder={tags().length ? "" : "Add tags…"} class="min-w-16 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
				onKeyDown={(e) => {
					e.stopPropagation();
					if ((e.key === "Enter" || e.key === ",") && !e.isComposing) { e.preventDefault(); add(e.currentTarget.value); e.currentTarget.value = ""; }
					else if (e.key === "Escape") e.currentTarget.blur();
				}}
				onBlur={(e) => { add(e.currentTarget.value); e.currentTarget.value = ""; }}
			/>
		</div>
	);
}
