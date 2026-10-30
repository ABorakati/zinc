// Citation style picker: search the installed styles and the Zotero Style Repository (~10,000 styles) with
// format/field filters, keyboard navigation and a live preview of the highlighted style. Used by the
// Citation Style Settings and Create Bibliography dialogs.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Component } from "solid-js";
import { Check, Download, Loader2, Search, Trash2, WifiOff } from "lucide-solid";
import { toast } from "solid-sonner";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { sanitizeNote } from "~/sanitize";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { bumpCite, citeApi, type CiteStyleInfo, type CiteStylePreview } from "./client";

const FORMATS: [string, string][] = [
	["", "Any format"], ["author-date", "Author-date"], ["numeric", "Numeric"], ["note", "Note"], ["label", "Label"], ["author", "Author"],
];
const FIELDS: string[] = [
	"medicine", "biology", "science", "psychology", "social_science", "humanities", "engineering", "physics", "chemistry", "law",
	"history", "philosophy", "political_science", "sociology", "communications", "anthropology", "geography", "linguistics",
	"literature", "theology", "geology", "zoology", "botany", "math", "astronomy", "generic-base",
];
const fieldLabel = (f: string) =>
	f === "generic-base" ? "Generic" : f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const formatLabel = (f: string) => FORMATS.find((x) => x[0] === f)?.[1] ?? f;

const PAGE = 100;
const selectCls =
	"h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

/** citeproc's left-margin/right-inline columns (numbers) become inline text; sanitizeNote drops the classes. */
function previewHtml(html: string): string {
	return sanitizeNote(
		html.replace(
			/<div class="csl-left-margin">([\s\S]*?)<\/div>\s*<div class="csl-right-inline">([\s\S]*?)<\/div>/g,
			'<span>$1 </span><span>$2</span>',
		),
	);
}

type Row = { kind: "head"; label: string } | { kind: "style"; s: CiteStyleInfo };

export const StylePicker: Component<{
	/** The style currently in use. */
	value: string;
	/** Called with the chosen style (after it was installed if needed). */
	onChange: (id: string, info?: CiteStyleInfo) => void;
	/** Items to preview with (the user's selection); omitted: a few from the library. */
	itemKeys?: string[];
	class?: string;
}> = (props) => {
	const [q, setQ] = createSignal("");
	const [format, setFormat] = createSignal("");
	const [field, setField] = createSignal("");
	const [instOnly, setInstOnly] = createSignal(false);
	const [list, setList] = createSignal<CiteStyleInfo[]>([]);
	const [total, setTotal] = createSignal(0);
	const [index, setIndex] = createSignal("fresh");
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal("");
	const [hi, setHi] = createSignal(""); // highlighted style id (drives the preview)
	const [busy, setBusy] = createSignal<"install" | "use" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = createSignal("");
	const [preview, setPreview] = createSignal<CiteStylePreview | null>(null);
	const [pvLoading, setPvLoading] = createSignal(false);
	const [pvError, setPvError] = createSignal("");
	let listEl: HTMLDivElement | undefined;
	let searchCtl: AbortController | undefined;
	let pvCtl: AbortController | undefined;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let pvTimer: ReturnType<typeof setTimeout> | undefined;
	const pvCache = new Map<string, CiteStylePreview>();
	onCleanup(() => { searchCtl?.abort(); pvCtl?.abort(); clearTimeout(searchTimer); clearTimeout(pvTimer); });

	const rows = createMemo<Row[]>(() => {
		const l = list();
		const inst = l.filter((s) => s.installed), repo = l.filter((s) => !s.installed);
		const out: Row[] = [];
		if (inst.length) { out.push({ kind: "head", label: `Installed (${inst.length})` }); for (const s of inst) out.push({ kind: "style", s }); }
		if (repo.length) {
			const label = instOnly() ? "" : `Zotero Style Repository${q() || format() || field() ? ` (${Math.max(total() - inst.length, repo.length)})` : ""}`;
			if (label) out.push({ kind: "head", label });
			for (const s of repo) out.push({ kind: "style", s });
		}
		return out;
	});
	const styles = createMemo(() => list());
	const current = createMemo(() => list().find((s) => s.id === hi()));

	// ---- search (debounced, cancels the request it replaces)
	const run = (append: boolean) => {
		searchCtl?.abort();
		const ctl = (searchCtl = new AbortController());
		setLoading(true);
		setError("");
		citeApi
			.searchStyles({ q: q().trim(), format: format(), field: field(), installed: instOnly(), limit: PAGE, offset: append ? list().length : 0 }, ctl.signal)
			.then((r) => {
				if (ctl.signal.aborted) return;
				const merged = append ? [...list(), ...r.styles.filter((s) => !list().some((x) => x.id === s.id))] : r.styles;
				setList(merged);
				setTotal(r.total);
				setIndex(r.index);
				setLoading(false);
				if (!append && !merged.some((s) => s.id === hi())) {
					setHi(merged.find((s) => s.id === props.value)?.id ?? merged[0]?.id ?? "");
				}
			})
			.catch((e) => {
				if (ctl.signal.aborted) return;
				setLoading(false);
				setError(e instanceof Error ? e.message : String(e));
			});
	};
	onMount(() => {
		setHi(props.value);
		run(false);
	});
	createEffect(on([q, format, field, instOnly], () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => run(false), 150);
	}, { defer: true }));

	// ---- live preview of the highlighted style (debounced; a newer selection cancels the older request)
	const keysKey = () => (props.itemKeys ?? []).slice(0, 3).join(",");
	createEffect(() => {
		const id = hi();
		const kk = keysKey();
		clearTimeout(pvTimer);
		pvCtl?.abort();
		if (!id) { setPreview(null); setPvLoading(false); return; }
		const hit = pvCache.get(`${id}|${kk}`);
		if (hit) { setPreview(hit); setPvError(""); setPvLoading(false); return; }
		setPvLoading(true);
		pvTimer = setTimeout(() => {
			const ctl = (pvCtl = new AbortController());
			citeApi.preview(id, kk ? kk.split(",") : [], ctl.signal).then(
				(p) => {
					if (ctl.signal.aborted) return;
					pvCache.set(`${id}|${kk}`, p);
					setPreview(p);
					setPvError("");
					setPvLoading(false);
				},
				(e) => {
					if (ctl.signal.aborted) return;
					setPreview(null);
					setPvError(e instanceof Error ? e.message : String(e));
					setPvLoading(false);
				},
			);
		}, 200);
	});

	// ---- keyboard
	const move = (delta: number) => {
		const l = styles();
		if (!l.length) return;
		const i = l.findIndex((s) => s.id === hi());
		const next = l[Math.min(Math.max((i < 0 ? 0 : i) + delta, 0), l.length - 1)]!;
		setHi(next.id);
		setConfirmRemove("");
		queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" }));
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
		else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
		else if (e.key === "PageDown") { e.preventDefault(); move(8); }
		else if (e.key === "PageUp") { e.preventDefault(); move(-8); }
		else if (e.key === "Enter" && hi() && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); void use(); }
	};

	// ---- actions
	const patch = (id: string, p: Partial<CiteStyleInfo>) => setList((l) => l.map((s) => (s.id === id ? { ...s, ...p } : s)));
	const install = async (s: CiteStyleInfo) => {
		const info = await citeApi.install(s.id);
		patch(s.id, { installed: true, removable: info.removable, title: info.title || s.title });
		// a dependent style brings its parent along: show it as installed too
		if (s.dependent) void run(false);
		bumpCite();
		return info;
	};
	const use = async () => {
		const s = current();
		if (!s || busy()) return;
		setBusy("use");
		try {
			const info = s.installed ? s : await install(s);
			props.onChange(s.id, { ...s, ...info, installed: true });
		} catch (e) {
			fail(`Could not use "${s.title}"`, e);
		} finally {
			setBusy(null);
		}
	};
	const doInstall = async () => {
		const s = current();
		if (!s || busy()) return;
		setBusy("install");
		try {
			await install(s);
			toast.success(`Installed "${s.title}"`);
		} catch (e) {
			fail(`Could not install "${s.title}"`, e);
		} finally {
			setBusy(null);
		}
	};
	const doRemove = async () => {
		const s = current();
		if (!s || busy()) return;
		if (confirmRemove() !== s.id) { setConfirmRemove(s.id); return; }
		setConfirmRemove("");
		setBusy("remove");
		try {
			await citeApi.remove(s.id);
			toast.success(`Removed "${s.title}"`);
			bumpCite();
			run(false);
		} catch (e) {
			fail(`Could not remove "${s.title}"`, e);
		} finally {
			setBusy(null);
		}
	};

	const chips = (s: CiteStyleInfo) => {
		const out: string[] = [];
		if (s.format) out.push(formatLabel(s.format));
		for (const f of (s.fields ?? []).filter((x) => x !== "generic-base").slice(0, 2)) out.push(fieldLabel(f));
		return out;
	};
	const chipCls = "shrink-0 rounded border bg-muted/50 px-1 text-[10px] leading-4 text-muted-foreground";

	return (
		<div class={cn("grid gap-2", props.class)} onKeyDown={onKey}>
			<div class="relative">
				<Search class="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
				<Input
					class="pl-8"
					autofocus
					placeholder="Search installed styles and the Zotero Style Repository (e.g. lancet, harvard, nature)"
					aria-label="Search citation styles"
					value={q()}
					onInput={(e) => setQ(e.currentTarget.value)}
				/>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<select class={selectCls} aria-label="Citation format" value={format()} onChange={(e) => setFormat(e.currentTarget.value)}>
					<For each={FORMATS}>{([k, v]) => <option value={k}>{v}</option>}</For>
				</select>
				<select class={selectCls} aria-label="Field" value={field()} onChange={(e) => setField(e.currentTarget.value)}>
					<option value="">Any field</option>
					<For each={FIELDS}>{(f) => <option value={f}>{fieldLabel(f)}</option>}</For>
				</select>
				<label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
					<input type="checkbox" class="size-3.5" checked={instOnly()} onChange={(e) => setInstOnly(e.currentTarget.checked)} />
					Installed only
				</label>
			</div>
			<Show when={index() === "none" && !instOnly()}>
				<div class="flex items-center gap-1.5 rounded-md border border-warning-foreground/30 bg-warning/20 px-2 py-1 text-xs">
					<WifiOff class="size-3.5 shrink-0" />The Zotero Style Repository could not be reached; only installed and default styles are listed.
				</div>
			</Show>
			<div class="grid min-h-0 grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-2">
				{/* ---- list */}
				<div ref={listEl} class="h-[22rem] overflow-y-auto rounded-md border" role="listbox" aria-label="Citation styles">
					<Show when={!error()} fallback={<div class="p-3 text-[13px] text-destructive">{error()}</div>}>
						<Show when={rows().length || !loading()} fallback={<div class="flex items-center gap-2 p-3 text-[13px] text-muted-foreground"><Loader2 class="size-4 animate-spin" />Searching…</div>}>
							<For each={rows()} fallback={<div class="p-3 text-[13px] text-muted-foreground">No styles match.</div>}>
								{(r) =>
									r.kind === "head" ? (
										<div class="sticky top-0 z-10 border-b bg-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{r.label}</div>
									) : (
										<button
											type="button"
											role="option"
											tabIndex={-1}
											data-id={r.s.id}
											aria-selected={hi() === r.s.id}
											class={cn("flex w-full flex-col gap-0.5 px-2 py-1 text-left text-[13px] hover:bg-accent/60", hi() === r.s.id && "bg-accent")}
											onClick={() => { setHi(r.s.id); setConfirmRemove(""); }}
											onDblClick={() => void use()}
										>
											<span class="flex items-center gap-1.5">
												<span class="size-4 shrink-0">{props.value === r.s.id && <Check class="size-4" aria-label="In use" />}</span>
												<span class="min-w-0 flex-1 truncate">{r.s.title}</span>
												<Show when={r.s.installed}><span class="shrink-0 text-[10px] text-muted-foreground">installed</span></Show>
											</span>
											<span class="flex items-center gap-1 pl-[22px]">
												<For each={chips(r.s)}>{(c) => <span class={chipCls}>{c}</span>}</For>
												<Show when={r.s.dependent}><span class={chipCls}>journal</span></Show>
											</span>
										</button>
									)
								}
							</For>
							<Show when={list().length < total()}>
								<button type="button" tabIndex={-1} class="w-full border-t px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60" onClick={() => run(true)} disabled={loading()}>
									{loading() ? "Loading…" : `Show more (${list().length} of ${total()})`}
								</button>
							</Show>
						</Show>
					</Show>
				</div>
				{/* ---- preview */}
				<div class="flex h-[22rem] min-w-0 flex-col rounded-md border">
					<Show when={current()} fallback={<div class="p-3 text-[13px] text-muted-foreground">Select a style to preview it.</div>}>
						{(s) => (
							<>
								<div class="border-b px-3 py-2">
									<div class="flex items-start gap-2">
										<div class="min-w-0 flex-1">
											<div class="truncate text-[13px] font-medium" title={s().title}>{s().title}</div>
											<div class="mt-0.5 flex flex-wrap items-center gap-1">
												<For each={chips(s())}>{(c) => <span class={chipCls}>{c}</span>}</For>
												<span class="text-[10px] text-muted-foreground">{s().installed ? "Installed" : "Not installed"}{s().dependent ? " · follows a parent style" : ""}</span>
											</div>
										</div>
										<Show when={pvLoading()}><Loader2 class="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Loading preview" /></Show>
									</div>
								</div>
								<div class="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px]" aria-live="polite" data-testid="style-preview">
									<Show when={!pvError()} fallback={<div class="text-destructive">Preview unavailable: {pvError()}</div>}>
										<Show when={preview()} fallback={<div class="text-muted-foreground">{pvLoading() ? "Loading preview…" : ""}</div>}>
											{(p) => (
												<div class={cn("transition-opacity", pvLoading() && "opacity-50")}>
													<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{p().note ? "Footnotes" : "In-text citations"}</div>
													<ul class="mb-3 space-y-1">
														<For each={p().citations}>{(c) => <li class="[&_sup]:text-[0.75em]" innerHTML={previewHtml(c)} />}</For>
													</ul>
													<Show when={p().bibliography}>
														<div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bibliography</div>
														<div class="space-y-1.5 [&_div]:break-words" innerHTML={previewHtml(p().bibliography)} />
													</Show>
													<div class="mt-3 text-[11px] text-muted-foreground">
														{p().sample ? "Built-in sample references (add items to your library to preview with them)." : (props.itemKeys?.length ? "Previewed with your selected items." : "Previewed with items from your library.")}
													</div>
												</div>
											)}
										</Show>
									</Show>
								</div>
								<div class="flex items-center gap-2 border-t px-3 py-2">
									<Show when={s().removable}>
										<Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" disabled={!!busy()} onClick={doRemove}>
											<Show when={busy() === "remove"} fallback={<Trash2 class="size-3" />}><Loader2 class="size-3 animate-spin" /></Show>
											{confirmRemove() === s().id ? "Confirm remove" : "Remove"}
										</Button>
									</Show>
									<div class="flex-1" />
									<Show when={!s().installed}>
										<Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" disabled={!!busy()} onClick={doInstall}>
											<Show when={busy() === "install"} fallback={<Download class="size-3" />}><Loader2 class="size-3 animate-spin" /></Show>
											Install
										</Button>
									</Show>
									<Button size="sm" class="h-7 px-3 text-xs" disabled={!!busy() || props.value === s().id} onClick={() => void use()}>
										<Show when={busy() === "use"}><Loader2 class="mr-1 size-3 animate-spin" /></Show>
										{props.value === s().id ? "In use" : "Use this style"}
									</Button>
								</div>
							</>
						)}
					</Show>
				</div>
			</div>
			<div class="text-xs text-muted-foreground">
				In use: <span class="font-mono">{props.value}</span>
				<Show when={total() > 0}><span> · {total()} style{total() === 1 ? "" : "s"} match</span></Show>
				<span> · Up/Down to browse, Enter to use</span>
			</div>
		</div>
	);
};
