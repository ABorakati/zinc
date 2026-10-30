// The Settings tab: section list on the left, searchable settings on the right.
// Everything shown comes from the registry (registry.ts); definitions live in defs/*.tsx.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Search, X } from "lucide-solid";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { settingsShown } from "./net";
import { allSettings, matches, queryTokens, sections, type SettingDef } from "./registry";
import "./defs";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text with the search words marked. */
const Hl: Component<{ text: string; tokens: string[] }> = (p) => {
	const parts = createMemo(() => (p.tokens.length ? p.text.split(new RegExp(`(${p.tokens.map(esc).join("|")})`, "gi")) : [p.text]));
	// split() with a capture group puts the matches at the odd indices
	return <>{parts().map((s, i) => (i % 2 ? <mark class="rounded-sm bg-primary/25 text-inherit">{s}</mark> : s))}</>;
};

const Row: Component<{ s: SettingDef; tokens: string[] }> = (p) => {
	const na = () => !!p.s.unavailable || !p.s.control;
	// keywords that made this row match, when the visible text alone does not show why
	const viaKeywords = () => {
		if (!p.tokens.length) return [];
		const seen = `${p.s.label} ${p.s.description ?? ""}`.toLowerCase();
		if (p.tokens.every((t) => seen.includes(t))) return [];
		return (p.s.keywords ?? []).filter((k) => p.tokens.some((t) => k.toLowerCase().includes(t))).slice(0, 4);
	};
	return (
		<div
			data-setting={p.s.id}
			aria-disabled={na() || undefined}
			class={cn("grid gap-x-6 gap-y-2 border-b py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]", p.s.layout === "block" && "sm:grid-cols-1")}
		>
			<div class={cn("min-w-0", na() && "opacity-60")}>
				<div class="flex flex-wrap items-center gap-2 text-sm font-medium">
					<span><Hl text={p.s.label} tokens={p.tokens} /></span>
					<Show when={na()}>
						<span class="rounded-full border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
							{typeof p.s.unavailable === "string" ? p.s.unavailable : "Not available yet"}
						</span>
					</Show>
				</div>
				<Show when={p.s.description}>
					<p class="mt-0.5 text-xs text-muted-foreground"><Hl text={p.s.description!} tokens={p.tokens} /></p>
				</Show>
				<Show when={viaKeywords().length}>
					<p class="mt-0.5 text-[11px] text-muted-foreground">Also: <Hl text={viaKeywords().join(", ")} tokens={p.tokens} /></p>
				</Show>
			</div>
			<Show when={!na()}>
				<div class={cn("flex min-w-0 items-center", p.s.layout === "block" ? "justify-start" : "sm:justify-end")}>{p.s.control!()}</div>
			</Show>
		</div>
	);
};

export const SettingsPage: Component<{ active: boolean }> = (props) => {
	const [query, setQuery] = createSignal("");
	const [current, setCurrent] = createSignal("");
	let search!: HTMLInputElement;
	let scroller!: HTMLDivElement;

	const tokens = createMemo(() => queryTokens(query()));
	const view = createMemo(() => {
		const t = tokens();
		const all = allSettings();
		return sections()
			.map((sec) => {
				const rows = all.filter((s) => s.section === sec.id && matches(s, sec, t));
				// sub-headings in order of first appearance; rows without a group lead
				const groups: { name?: string; rows: SettingDef[] }[] = [];
				for (const r of rows) {
					let g = groups.find((x) => x.name === r.group);
					if (!g) groups.push((g = { name: r.group, rows: [] }));
					g.rows.push(r);
				}
				groups.sort((a, b) => Number(!!a.name) - Number(!!b.name));
				return { sec, count: rows.length, groups };
			})
			.filter((v) => v.count);
	});
	const total = () => view().reduce((n, v) => n + v.count, 0);
	const countOf = (id: string) => view().find((v) => v.sec.id === id)?.count ?? 0;

	// section currently at the top of the scroll area
	const spy = () => {
		const top = scroller.getBoundingClientRect().top + 60;
		let id = view()[0]?.sec.id ?? "";
		for (const v of view()) {
			const el = scroller.querySelector<HTMLElement>(`[data-section="${v.sec.id}"]`);
			if (el && el.getBoundingClientRect().top <= top) id = v.sec.id;
		}
		setCurrent(id);
	};
	const goTo = (id: string) => {
		scroller.querySelector<HTMLElement>(`[data-section="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
		setCurrent(id);
	};
	const focusFirst = () => scroller.querySelector<HTMLElement>("[data-setting]:not([aria-disabled]) :is(button, input, select, textarea):not([disabled])")?.focus();

	// a new query shows a new list: start at the top
	createEffect(() => { query(); scroller?.scrollTo({ top: 0 }); queueMicrotask(spy); });
	createEffect(() => { if (props.active) { settingsShown(); queueMicrotask(() => search?.focus()); } });

	const focusSearch = () => { search.focus(); search.select(); };
	const onKey = (e: KeyboardEvent) => {
		if (!props.active || e.defaultPrevented) return;
		const t = e.target instanceof Element ? e.target : null;
		if (t?.closest("[role='dialog'], [role='alertdialog'], [role='menu']")) return;
		const typing = !!t?.closest("input, textarea, select, [contenteditable='true']");
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
			e.preventDefault(); e.stopPropagation(); focusSearch();
		} else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault(); e.stopPropagation(); focusSearch();
		}
	};
	onMount(() => window.addEventListener("keydown", onKey, true));
	onCleanup(() => window.removeEventListener("keydown", onKey, true));

	return (
		<div class="flex h-full w-full min-w-0 bg-background" data-testid="settings-page">
			<nav class="flex w-52 flex-none flex-col gap-0.5 overflow-y-auto border-r bg-card p-2" aria-label="Settings sections">
				<h1 class="px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</h1>
				<For each={sections()}>{(sec) => {
					const n = () => countOf(sec.id);
					return (
						<button
							type="button"
							data-nav={sec.id}
							aria-current={current() === sec.id ? "true" : undefined}
							disabled={n() === 0}
							class={cn(
								"flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:flex-none",
								current() === sec.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
							)}
							onClick={() => goTo(sec.id)}
						>
							<Show when={sec.icon}>{(I) => { const C = I(); return <C />; }}</Show>
							<span class="min-w-0 flex-1 truncate">{sec.label}</span>
							<Show when={tokens().length}><span class="rounded-full bg-primary/15 px-1.5 text-[10px] leading-4 text-primary">{n()}</span></Show>
						</button>
					);
				}}</For>
			</nav>

			<div class="flex min-w-0 flex-1 flex-col">
				<div class="flex flex-none items-center gap-2 border-b px-6 py-2.5">
					<div class="relative max-w-xl flex-1">
						<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							ref={search}
							type="text"
							role="searchbox"
							class="h-8 px-7"
							placeholder="Search settings   ( / or Ctrl+F )"
							aria-label="Search settings"
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") { e.stopPropagation(); if (query()) setQuery(""); else search.blur(); }
								else if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); focusFirst(); }
							}}
						/>
						<Show when={query()}>
							<button type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear search"
								onClick={() => { setQuery(""); search.focus(); }}>
								<X class="size-3.5" />
							</button>
						</Show>
					</div>
					<Show when={tokens().length}>
						<span class="text-xs text-muted-foreground" aria-live="polite">{total()} {total() === 1 ? "setting" : "settings"}</span>
					</Show>
				</div>

				<div ref={scroller} class="min-h-0 flex-1 overflow-y-auto scroll-smooth px-6 pb-24" onScroll={spy}>
					<div class="mx-auto max-w-3xl">
						<For each={view()}>{(v) => (
							<section data-section={v.sec.id} aria-labelledby={`settings-h-${v.sec.id}`} class="pt-6">
								<h2 id={`settings-h-${v.sec.id}`} class="text-base font-semibold">{v.sec.label}</h2>
								<Show when={v.sec.description}><p class="mt-0.5 text-xs text-muted-foreground">{v.sec.description}</p></Show>
								<div class="mt-2 rounded-lg border bg-card px-4">
									<For each={v.groups}>{(g) => (
										<>
											<Show when={g.name}>
												<h3 class="border-b pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground last:border-0">{g.name}</h3>
											</Show>
											<For each={g.rows}>{(s) => <Row s={s} tokens={tokens()} />}</For>
										</>
									)}</For>
								</div>
							</section>
						)}</For>
						<Show when={view().length === 0}>
							<div class="flex flex-col items-center gap-3 py-24 text-center" role="status">
								<Search class="size-8 text-muted-foreground/50" />
								<p class="text-sm">No settings match “{query().trim()}”</p>
								<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={() => { setQuery(""); search.focus(); }}>Clear search</Button>
							</div>
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
};
