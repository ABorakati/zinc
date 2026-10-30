// Small form controls for the Settings page, styled like the rest of the app (see cards/Customize.tsx, searches/QuickSearchMode.tsx).
import { createEffect, createSignal, For, Show, type Component, type JSX } from "solid-js";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";

export interface Option<T extends string> { value: T; label: string; hint?: string }

export const Switch: Component<{ checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = (p) => (
	<button
		type="button"
		role="switch"
		aria-checked={p.checked}
		aria-label={p.label}
		disabled={p.disabled}
		class={cn(
			"relative inline-flex h-5 w-9 flex-none items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
			p.checked ? "bg-primary" : "bg-input",
		)}
		onClick={() => p.onChange(!p.checked)}
	>
		<span class={cn("pointer-events-none block size-4 rounded-full bg-background shadow transition-transform", p.checked ? "translate-x-[18px]" : "translate-x-0.5")} />
	</button>
);

export function Select<T extends string>(p: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; disabled?: boolean; class?: string }) {
	return (
		<select
			aria-label={p.label}
			disabled={p.disabled}
			class={cn("h-7 min-w-44 max-w-64 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50", p.class)}
			value={p.value}
			onChange={(e) => p.onChange(e.currentTarget.value as T)}
		>
			<For each={p.options}>{(o) => <option value={o.value} selected={o.value === p.value} title={o.hint}>{o.label}</option>}</For>
		</select>
	);
}

/** Radio buttons as a pill row. */
export function Segmented<T extends string>(p: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
	return (
		<div role="radiogroup" aria-label={p.label} class="inline-flex rounded-md border bg-muted/50 p-0.5">
			<For each={p.options}>{(o) => (
				<button
					type="button"
					role="radio"
					aria-checked={p.value === o.value}
					disabled={p.disabled}
					title={o.hint}
					class={cn("rounded-[5px] px-2.5 py-1 text-xs whitespace-nowrap transition-colors disabled:opacity-50", p.value === o.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
					onClick={() => p.onChange(o.value)}
				>{o.label}</button>
			)}</For>
		</div>
	);
}

/** Radio list with a hint under each option. */
export function Radios<T extends string>(p: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; name: string }) {
	return (
		<div role="radiogroup" aria-label={p.label} class="flex flex-col gap-0.5">
			<For each={p.options}>{(o) => (
				<label class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent has-[:checked]:bg-accent">
					<input type="radio" name={p.name} class="mt-1 accent-primary" checked={p.value === o.value} onChange={() => p.onChange(o.value)} />
					<span class="flex flex-col"><span>{o.label}</span><Show when={o.hint}><span class="text-xs text-muted-foreground">{o.hint}</span></Show></span>
				</label>
			)}</For>
		</div>
	);
}

export const Slider: Component<{
	value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string; disabled?: boolean;
}> = (p) => (
	<div class="flex items-center gap-2">
		<input
			type="range"
			aria-label={p.label}
			min={p.min}
			max={p.max}
			step={p.step}
			value={p.value}
			disabled={p.disabled}
			class="h-4 w-40 accent-primary disabled:opacity-50"
			onInput={(e) => p.onChange(e.currentTarget.valueAsNumber)}
		/>
		<span class="w-14 text-right text-xs tabular-nums text-muted-foreground">{(p.format ?? String)(p.value)}</span>
	</div>
);

/** Text input that commits on Enter/blur (so each keystroke does not hit the server or storage). */
export const TextField: Component<{
	value: string; onCommit: (v: string) => void; label: string; placeholder?: string; type?: string; disabled?: boolean; class?: string;
}> = (p) => {
	const [text, setText] = createSignal(p.value);
	createEffect(() => setText(p.value));
	const commit = () => { if (text() !== p.value) p.onCommit(text()); };
	return (
		<Input
			type={p.type ?? "text"}
			aria-label={p.label}
			placeholder={p.placeholder}
			disabled={p.disabled}
			class={cn("w-64", p.class)}
			value={text()}
			onInput={(e) => setText(e.currentTarget.value)}
			onBlur={commit}
			onKeyDown={(e) => { if (e.key === "Enter") { commit(); e.currentTarget.blur(); } else if (e.key === "Escape") { setText(p.value); e.currentTarget.blur(); } }}
		/>
	);
};

export const Kbd: Component<{ children: JSX.Element }> = (p) => (
	<kbd class="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{p.children}</kbd>
);

/** Read-only value (paths, status). */
export const Value: Component<{ children: JSX.Element; title?: string }> = (p) => (
	<span class="block max-w-96 truncate text-xs text-muted-foreground" title={p.title}>{p.children}</span>
);
