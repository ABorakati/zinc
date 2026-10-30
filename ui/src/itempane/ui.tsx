import { createEffect, createSignal, For, on, onCleanup, Show, type Component, type JSX } from "solid-js";
import { ChevronDown, ChevronRight, type LucideProps } from "lucide-solid";
import { Dynamic } from "solid-js/web";
import { cn } from "~/lib/utils";
import { isCollapsed, setCollapsed } from "./ctx";

// ---- Section -----------------------------------------------------------------
export const Section: Component<{
	id: string;
	title: string;
	icon: Component<LucideProps>;
	count?: number;
	actions?: JSX.Element;
	children: JSX.Element;
}> = (p) => (
	<section id={`ip-sec-${p.id}`} data-sec={p.id} class="border-t first:border-t-0">
		<div
			class="group/sec flex h-7 items-center gap-1.5 px-2 select-none hover:bg-accent/40"
			onClick={() => setCollapsed(p.id, !isCollapsed(p.id))}
		>
			<Dynamic component={isCollapsed(p.id) ? ChevronRight : ChevronDown} class="size-3.5 flex-none text-muted-foreground" />
			<Dynamic component={p.icon} class="size-3.5 flex-none text-muted-foreground" />
			<span class="text-[13px] font-semibold">{p.title}</span>
			<Show when={p.count !== undefined && p.count > 0}>
				<span class="text-[11px] text-muted-foreground">{p.count}</span>
			</Show>
			<div class="flex-1" />
			<div class="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>{p.actions}</div>
		</div>
		<Show when={!isCollapsed(p.id)}>
			<div class="px-2 pt-0.5 pb-2.5">{p.children}</div>
		</Show>
	</section>
);

// ---- small controls ------------------------------------------------------------
export const IconBtn: Component<{
	title: string;
	onClick?: (e: MouseEvent) => void;
	disabled?: boolean;
	class?: string;
	children: JSX.Element;
}> = (p) => (
	<button
		type="button"
		title={p.title}
		aria-label={p.title}
		disabled={p.disabled}
		onClick={p.onClick}
		class={cn(
			"inline-flex size-5 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5",
			p.class,
		)}
	>
		{p.children}
	</button>
);

export const TextBtn: Component<{
	onClick?: (e: MouseEvent) => void;
	disabled?: boolean;
	primary?: boolean;
	title?: string;
	class?: string;
	children: JSX.Element;
}> = (p) => (
	<button
		type="button"
		title={p.title}
		disabled={p.disabled}
		onClick={p.onClick}
		class={cn(
			"inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
			p.primary ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/90" : "bg-transparent hover:bg-accent",
			p.class,
		)}
	>
		{p.children}
	</button>
);

/** A label/value row in Zotero's two-column style. */
export const Row: Component<{ label: string; children: JSX.Element; class?: string; labelClass?: string; id?: string }> = (p) => (
	<div class={cn("group/row grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2 py-[2px]", p.class)} data-field={p.id}>
		<label class={cn("truncate pt-[4px] text-right text-xs text-muted-foreground", p.labelClass)} title={p.label}>{p.label}</label>
		<div class="min-w-0">{p.children}</div>
	</div>
);

// ---- click-to-edit text --------------------------------------------------------
export const Editable: Component<{
	value: string;
	onSave: (v: string) => void;
	multiline?: boolean;
	placeholder?: string;
	class?: string;
	/** extra elements inside the value cell, after the text (e.g. link button) */
	end?: JSX.Element;
	ariaLabel?: string;
	/** called whenever editing starts/stops */
	onEditing?: (e: boolean) => void;
}> = (p) => {
	const [editing, setEditingRaw] = createSignal(false);
	const setEditing = (v: boolean) => { setEditingRaw(v); p.onEditing?.(v); };
	let cancelled = false;
	const commit = (v: string) => {
		setEditing(false);
		if (cancelled) { cancelled = false; return; }
		if (v !== p.value) p.onSave(v);
	};
	// a visible outline at rest (not only while editing), so fields read as fields
	const base = "w-full min-w-0 rounded border px-1.5 py-[2px] text-[13px] leading-[18px]";
	return (
		<Show
			when={editing()}
			fallback={
				<div
					tabindex={0}
					role="textbox"
					aria-label={p.ariaLabel}
					class={cn(
						base,
						"min-h-[24px] cursor-text break-words whitespace-pre-wrap border-input bg-background/40 outline-none transition-colors hover:border-ring/60 hover:bg-accent/40 focus-visible:border-ring",
						!p.value && "text-muted-foreground/70",
						p.class,
					)}
					onFocus={() => { cancelled = false; setEditing(true); }}
					onClick={() => { cancelled = false; setEditing(true); }}
				>
					{p.value || p.placeholder || " "}
					{p.end}
				</div>
			}
		>
			{(() => {
				const props = {
					value: p.value,
					"aria-label": p.ariaLabel,
					placeholder: p.placeholder,
					ref: (el: HTMLInputElement | HTMLTextAreaElement) => queueMicrotask(() => { el.focus(); if (!p.multiline) el.select(); else el.setSelectionRange(el.value.length, el.value.length); }),
					onBlur: (e: FocusEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => commit(e.currentTarget.value),
					onKeyDown: (e: KeyboardEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
						if (e.key === "Escape") { cancelled = true; e.currentTarget.blur(); }
						else if (e.key === "Enter" && (!p.multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur(); }
					},
				};
				const cls = cn(base, "min-h-[24px] border-ring bg-background outline-none ring-2 ring-ring/25", p.class);
				return p.multiline ? (
					<textarea {...props} rows={2} class={cn(cls, "[field-sizing:content] max-h-72 min-h-[44px] resize-none")} />
				) : (
					<input {...props} class={cls} />
				);
			})()}
		</Show>
	);
};

/** Native <select> restyled to sit in Zotero-like rows. */
export const NativeSelect: Component<{
	value: string;
	options: { value: string; label: string }[];
	onChange: (v: string) => void;
	class?: string;
	ariaLabel?: string;
}> = (p) => (
	<select
		aria-label={p.ariaLabel}
		class={cn(
			"h-[24px] max-w-full cursor-pointer appearance-none rounded border border-input bg-background/40 px-1.5 text-[13px] outline-none transition-colors hover:border-ring/60 hover:bg-accent/40 focus-visible:border-ring [&>option]:bg-popover [&>option]:text-popover-foreground",
			p.class,
		)}
		value={p.value}
		onChange={(e) => p.onChange(e.currentTarget.value)}
	>
		<For each={p.options}>{(o) => <option value={o.value} selected={o.value === p.value}>{o.label}</option>}</For>
	</select>
);

// ---- search picker (autocomplete dropdown) ---------------------------------------
export function Picker<T>(p: {
	placeholder: string;
	query: (q: string) => Promise<T[]> | T[];
	render: (t: T) => JSX.Element;
	onPick: (t: T) => void;
	/** Enter with no highlighted result */
	onSubmitText?: (q: string) => void;
	onClose?: () => void;
	autofocus?: boolean;
	class?: string;
	inputClass?: string;
	/** keep the typed text/focus after picking (default clears text) */
	keepOpen?: boolean;
	ariaLabel?: string;
}) {
	const [q, setQ] = createSignal("");
	const [results, setResults] = createSignal<T[]>([]);
	const [open, setOpen] = createSignal(false);
	const [hi, setHi] = createSignal(-1);
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));

	const run = (text: string) => {
		const my = ++seq;
		Promise.resolve(p.query(text)).then(
			(r) => { if (my === seq) { setResults(r); setHi(r.length && text ? 0 : -1); } },
			() => { if (my === seq) setResults([]); },
		);
	};
	createEffect(on(q, (text) => { clearTimeout(timer); if (open()) timer = setTimeout(() => run(text), 100); }, { defer: true }));

	const pick = (t: T) => {
		p.onPick(t);
		setQ("");
		if (p.keepOpen) run("");
		else setOpen(false);
	};
	return (
		<div class={cn("relative", p.class)}>
			<input
				ref={(el) => p.autofocus && queueMicrotask(() => el.focus())}
				aria-label={p.ariaLabel ?? p.placeholder}
				class={cn(
					"h-6 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
					p.inputClass,
				)}
				placeholder={p.placeholder}
				value={q()}
				onInput={(e) => { setQ(e.currentTarget.value); setOpen(true); }}
				onFocus={() => { setOpen(true); run(q()); }}
				onBlur={() => { setOpen(false); p.onClose?.(); }}
				onKeyDown={(e) => {
					const n = results().length;
					if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((hi() + 1) % Math.max(n, 1)); }
					else if (e.key === "ArrowUp") { e.preventDefault(); setHi((hi() - 1 + n) % Math.max(n, 1)); }
					else if (e.key === "Enter") {
						e.preventDefault();
						const r = results()[hi()];
						if (open() && r !== undefined) pick(r);
						else if (q().trim() && p.onSubmitText) { p.onSubmitText(q().trim()); setQ(""); }
					} else if (e.key === "Escape") { setOpen(false); setQ(""); e.currentTarget.blur(); }
				}}
			/>
			<Show when={open() && results().length > 0}>
				<ul class="absolute top-full right-0 left-0 z-30 mt-0.5 max-h-52 overflow-y-auto rounded-md border bg-popover py-0.5 text-popover-foreground shadow-md" role="listbox">
					<For each={results()}>
						{(r, i) => (
							<li
								role="option"
								aria-selected={i() === hi()}
								class={cn("cursor-default truncate px-2 py-1 text-xs", i() === hi() && "bg-accent text-accent-foreground")}
								onMouseEnter={() => setHi(i())}
								onMouseDown={(e) => { e.preventDefault(); pick(r); }}
							>
								{p.render(r)}
							</li>
						)}
					</For>
				</ul>
			</Show>
		</div>
	);
}
