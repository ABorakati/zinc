// The reflowed reading view: DocStructure as a clean article with user typography.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { DocStructure, PdfRect, ViewerHandle } from "../contract";
import { buildItems, firstItemOnPage, type ReflowItem } from "./build";
import { READING_CSS } from "./css";
import {
	contrastColor, DEFAULT_SETTINGS, fontStack, isFontInstalled, LIMITS, palette, type FontKind, type ReadingSettings, type ThemeKind,
} from "./settings";

export type LoadState =
	| { phase: "loading"; pct: number }
	| { phase: "error"; message: string }
	| { phase: "ready"; doc: DocStructure };

export interface CitationDetail {
	page: number;
	top: number | undefined;
	text: string;
	clientX: number;
	clientY: number;
	kind: "hover" | "click";
}

export interface ReflowProps {
	viewer: ViewerHandle;
	state: () => LoadState;
	retry: () => void;
	settings: () => ReadingSettings;
	setSettings: (patch: Partial<ReadingSettings>) => void;
	resetSettings: () => void;
	/** Called when the view is torn down; receives the page to show in the page view. */
	onLeave: (target: { page: number; top?: number }) => void;
	close: () => void;
}

const pad = (r: PdfRect, d: number): PdfRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

export function ReflowView(props: ReflowProps) {
	let scroller!: HTMLDivElement;
	let article: HTMLElement | undefined;
	const items = createMemo<ReflowItem[]>(() => {
		const s = props.state();
		return s.phase === "ready" ? buildItems(s.doc) : [];
	});
	const pal = createMemo(() => palette(props.settings()));
	const [menuOpen, setMenuOpen] = createSignal(false);

	// ------------------------------------------------------------ position sync
	let topPage = props.viewer.page();
	let override: { page: number; top?: number } | null = null;
	let raf = 0;
	const trackTop = () => {
		raf = 0;
		if (!article) return;
		const top = scroller.getBoundingClientRect().top + 12;
		for (const el of Array.from(article.children) as HTMLElement[]) {
			const p = el.dataset.page;
			if (p === undefined) continue;
			if (el.getBoundingClientRect().bottom > top) { topPage = Number(p); return; }
		}
	};
	const onScroll = () => { if (!raf) raf = requestAnimationFrame(trackTop); };

	let entered = false;
	createEffect(() => {
		const its = items();
		if (!its.length || entered) return;
		entered = true;
		queueMicrotask(() => {
			const idx = firstItemOnPage(its, props.viewer.page());
			const el = article?.querySelector<HTMLElement>(`[data-item="${CSS.escape(its[idx].id)}"]`);
			el?.scrollIntoView({ block: "start" });
			if (el) topPage = its[idx].page;
		});
	});

	onCleanup(() => {
		cancelAnimationFrame(raf);
		props.onLeave(override ?? { page: topPage });
	});

	/** "View on page": switch back to the page view at this location. */
	const viewOnPage = (page: number, top?: number) => {
		override = { page, top };
		props.close();
	};

	// ------------------------------------------------------------ citations
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	const detailFor = (a: HTMLElement, e: MouseEvent, kind: "hover" | "click"): CitationDetail => {
		const top = Number(a.dataset.top);
		return {
			page: Number(a.dataset.page), top: Number.isFinite(top) && a.dataset.top !== undefined ? top : undefined,
			text: a.textContent ?? "", clientX: e.clientX, clientY: e.clientY, kind,
		};
	};
	const cite = (e: MouseEvent) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>("a.rx-cite") ?? null;
	const onClick = (e: MouseEvent) => {
		const a = cite(e);
		if (!a) return;
		e.preventDefault();
		clearTimeout(hoverTimer);
		const detail = detailFor(a, e, "click");
		const ev = new CustomEvent("reader-next:citation", { detail, cancelable: true });
		// nobody claimed it (no popup layer listening): fall back to jumping to the target in the page view
		if (window.dispatchEvent(ev) && Number.isFinite(detail.page)) viewOnPage(detail.page, detail.top);
	};
	const onOver = (e: MouseEvent) => {
		const a = cite(e);
		if (!a) return;
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => window.dispatchEvent(new CustomEvent("reader-next:citation", { detail: detailFor(a, e, "hover") })), 220);
	};
	const onOut = (e: MouseEvent) => {
		if (!cite(e)) return;
		clearTimeout(hoverTimer);
		window.dispatchEvent(new CustomEvent("reader-next:citation-leave"));
	};
	onCleanup(() => clearTimeout(hoverTimer));

	const s = props.settings;
	const rootStyle = (): JSX.CSSProperties => ({
		"color-scheme": pal().dark ? "dark" : "light", "--rn-reading-bg": pal().bg, "--rn-reading-fg": pal().fg,
		"--rr-muted": pal().muted, "--rr-rule": pal().rule, "--rr-cite": pal().cite, "--rr-cite-bg": pal().citeBg,
		"--rr-font": fontStack(s()), "--rr-size": `${s().size}px`, "--rr-lh": String(s().lineHeight), "--rr-width": `${s().width}px`,
		"--rr-align": s().justify ? "justify" : "left", "--rr-hyphens": s().justify ? "auto" : "manual",
	});

	return (
		<div class="rr-reading" data-theme={s().theme} style={rootStyle()} data-testid="rr-reading">
			<style>{READING_CSS}</style>
			<div class="rr-reading-bar">
				<button class="rr-reading-btn" title="Typography and theme" aria-expanded={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} data-testid="rr-reading-typo">
					<span style={{ "font-family": "Georgia, serif" }}>A</span><span style={{ "font-size": "0.75em", "font-family": "Georgia, serif" }}>a</span>
				</button>
				<button class="rr-reading-btn" title="Back to the PDF page view" onClick={() => props.close()} data-testid="rr-reading-close">PDF</button>
			</div>
			<Show when={menuOpen()}>
				<Typography settings={s} set={props.setSettings} reset={props.resetSettings} close={() => setMenuOpen(false)} />
			</Show>
			<div class="rr-reading-scroll" ref={scroller} onScroll={onScroll} onClick={onClick} onMouseOver={onOver} onMouseOut={onOut}>
				<Show when={props.state().phase === "ready"} fallback={<Status state={props.state} retry={props.retry} />}>
					<article class="rr-article" ref={(el) => (article = el)} data-testid="rr-article">
						<For each={items()}>{(it) => <Item it={it} viewer={props.viewer} scroller={() => scroller} dark={() => s().theme === "dark"} viewOnPage={viewOnPage} />}</For>
						<Show when={items().length === 0}><p class="rr-empty">No readable text was found in this document.</p></Show>
					</article>
				</Show>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- status

function Status(props: { state: () => LoadState; retry: () => void }) {
	return (
		<div class="rr-status" role="status" data-testid="rr-reading-status">
			<Show when={props.state().phase === "loading"}>
				{(() => {
					const pct = () => { const st = props.state(); return st.phase === "loading" ? st.pct : 0; };
					return (
						<>
							<div class="rr-status-title">Preparing the reading view</div>
							<div class="rr-status-sub">Analysing the layout of this PDF. The first time takes a few seconds; after that it is instant.</div>
							<div class="rr-progress"><div class="rr-progress-bar" style={{ width: `${Math.max(4, pct())}%` }} /></div>
							<div class="rr-status-sub" data-testid="rr-reading-pct">{Math.round(pct())}%</div>
						</>
					);
				})()}
			</Show>
			<Show when={props.state().phase === "error"}>
				<div class="rr-status-title">The reading view could not be built</div>
				<div class="rr-status-sub">{(props.state() as { message?: string }).message}</div>
				<button class="rr-reading-btn rr-wide" onClick={props.retry}>Try again</button>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------- items

function Item(props: { it: ReflowItem; viewer: ViewerHandle; scroller: () => HTMLElement; dark: () => boolean; viewOnPage: (page: number, top?: number) => void }) {
	const it = props.it;
	const common = { "data-item": it.id, "data-page": it.page, "data-blocks": it.blockIds.join(" ") };
	switch (it.kind) {
		case "title": return <h1 class="rr-title" {...common} innerHTML={it.html} />;
		case "heading": return <Dynamic component={`h${Math.min(it.level + 1, 6)}`} class={`rr-h rr-h${it.level}`} {...common} innerHTML={it.html} />;
		case "para": return <p class="rr-p" {...common} innerHTML={it.html} />;
		case "list": return <div class="rr-list" {...common} innerHTML={it.html} />;
		case "code": return <pre class="rr-code" {...common}>{it.text}</pre>;
		case "notes": return (
			<aside class="rr-notes" {...common}>
				<For each={it.html}>{(h) => <p innerHTML={h} />}</For>
			</aside>
		);
		case "refs": return (
			<ol class="rr-refs" {...common}>
				<For each={it.entries}>{(e) => <li data-blocks={e.id} data-page={e.page} innerHTML={e.html} />}</For>
			</ol>
		);
		case "equation": return (
			<div class="rr-equation" {...common}>
				<Region viewer={props.viewer} scroller={props.scroller} page={it.page} rect={it.rect} maxWidth={900} class={props.dark() ? "rr-eq-dark" : "rr-eq"} />
			</div>
		);
		case "figure": return (
			<figure class={`rr-figure rr-${it.type}`} classList={{ "rr-wide": it.wide }} {...common}>
				<Region viewer={props.viewer} scroller={props.scroller} page={it.page} rect={it.rect} maxWidth={1000} class="rr-fig-img" />
				<Show when={it.captionHtml}><figcaption innerHTML={it.captionHtml} /></Show>
				<button class="rr-viewpage" onClick={() => props.viewOnPage(it.page, it.rect[3])}>View on page {it.page + 1}</button>
			</figure>
		);
	}
}

/** A lazily rendered crop of a page region (renders when scrolled near the viewport). */
function Region(props: { viewer: ViewerHandle; scroller: () => HTMLElement; page: number; rect: PdfRect; maxWidth: number; class?: string }) {
	let box!: HTMLDivElement;
	const [state, setState] = createSignal<"idle" | "busy" | "done" | "error">("idle");
	const r = pad(props.rect, 2);
	const aspect = (r[2] - r[0]) / Math.max(1, r[3] - r[1]);
	onMount(() => {
		let disposed = false;
		const run = async () => {
			setState("busy");
			try {
				const canvas = await props.viewer.renderRegion(props.page, r, props.maxWidth);
				if (disposed) return;
				canvas.style.width = "100%";
				canvas.style.height = "auto";
				canvas.style.display = "block";
				box.replaceChildren(canvas);
				setState("done");
			}
			catch (e) { console.warn("[reflow] renderRegion failed", e); if (!disposed) setState("error"); }
		};
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) { io.disconnect(); void run(); }
		}, { root: props.scroller(), rootMargin: "900px 0px" });
		io.observe(box);
		onCleanup(() => { disposed = true; io.disconnect(); });
	});
	return (
		<div ref={box} class={`rr-region ${props.class ?? ""}`} data-state={state()} style={{ "aspect-ratio": String(aspect), "max-width": `${Math.round((r[2] - r[0]) * 2.4)}px` }}>
			<Show when={state() === "error"}><span class="rr-region-err">Image unavailable</span></Show>
		</div>
	);
}

// ---------------------------------------------------------------- typography popover

const FONTS: { id: FontKind; label: string; sample: string }[] = [
	{ id: "serif", label: "Serif", sample: "Charter, Georgia, serif" },
	{ id: "sans", label: "Sans", sample: "Segoe UI, system-ui, sans-serif" },
	{ id: "dyslexic", label: "Dyslexia-friendly", sample: "Atkinson Hyperlegible, Verdana, sans-serif" },
	{ id: "custom", label: "Other…", sample: "inherit" },
];
const THEMES: { id: ThemeKind; label: string; bg: string; fg: string }[] = [
	{ id: "light", label: "Light", bg: "#fbfaf7", fg: "#1f1e1c" },
	{ id: "sepia", label: "Sepia", bg: "#f4ecd8", fg: "#3b2f22" },
	{ id: "dark", label: "Dark", bg: "#17181b", fg: "#dedcd6" },
];

function Typography(props: { settings: () => ReadingSettings; set: (p: Partial<ReadingSettings>) => void; reset: () => void; close: () => void }) {
	const s = props.settings;
	let pop!: HTMLDivElement;
	const [installed, setInstalled] = createSignal<boolean | null>(null);
	const dyslexicInstalled = isFontInstalled("Atkinson Hyperlegible") || isFontInstalled("OpenDyslexic");
	createEffect(on(() => [s().font, s().customFont] as const, ([f, name]) => {
		setInstalled(f === "custom" && name.trim() ? isFontInstalled(name.trim()) : null);
	}));
	onMount(() => {
		const down = (e: PointerEvent) => {
			if (pop.contains(e.target as Node)) return;
			if ((e.target as HTMLElement).closest?.("[data-testid=rr-reading-typo]")) return;
			props.close();
		};
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") props.close(); };
		document.addEventListener("pointerdown", down, true);
		document.addEventListener("keydown", key);
		onCleanup(() => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); });
	});
	const slider = (label: string, key: "size" | "lineHeight" | "width", [lo, hi]: readonly [number, number], step: number, fmt: (v: number) => string) => (
		<label class="rr-row">
			<span class="rr-row-label">{label}</span>
			<input type="range" min={lo} max={hi} step={step} value={s()[key]} onInput={(e) => props.set({ [key]: Number(e.currentTarget.value) })} data-testid={`rr-set-${key}`} />
			<span class="rr-row-val">{fmt(s()[key])}</span>
		</label>
	);
	return (
		<div class="rr-pop" ref={pop} role="dialog" aria-label="Typography and theme" data-testid="rr-reading-pop">
			<div class="rr-pop-h">Font</div>
			<div class="rr-seg">
				<For each={FONTS}>{(f) => (
					<button classList={{ on: s().font === f.id }} style={{ "font-family": f.sample }} onClick={() => props.set({ font: f.id })} data-testid={`rr-font-${f.id}`}>{f.label}</button>
				)}</For>
			</div>
			<Show when={s().font === "custom"}>
				<input class="rr-text" type="text" placeholder="Any installed font, e.g. Georgia" value={s().customFont} spellcheck={false}
					onInput={(e) => props.set({ customFont: e.currentTarget.value })} data-testid="rr-font-custom-name" />
				<Show when={installed() !== null}><div class="rr-hint">{installed() ? "Found on this computer." : "Not found here; falling back to a serif font."}</div></Show>
			</Show>
			<Show when={s().font === "dyslexic" && !dyslexicInstalled}>
				<div class="rr-hint">Atkinson Hyperlegible / OpenDyslexic are not installed; using Verdana. Install either font to use it here.</div>
			</Show>
			{slider("Size", "size", LIMITS.size, 1, (v) => `${v}px`)}
			{slider("Line height", "lineHeight", LIMITS.lineHeight, 0.05, (v) => v.toFixed(2))}
			{slider("Column", "width", LIMITS.width, 20, (v) => `${v}px`)}
			<div class="rr-pop-h">Theme</div>
			<div class="rr-themes">
				<For each={THEMES}>{(t) => (
					<button class="rr-theme" classList={{ on: s().theme === t.id }} style={{ background: t.bg, color: t.fg }} onClick={() => props.set({ theme: t.id })} data-testid={`rr-theme-${t.id}`}>{t.label}</button>
				)}</For>
				<label class="rr-theme" classList={{ on: s().theme === "custom" }} style={{ background: s().customBg, color: contrastColor(s().customBg) }} data-testid="rr-theme-custom">
					Custom
					<input type="color" value={s().customBg} onInput={(e) => props.set({ theme: "custom", customBg: e.currentTarget.value })} data-testid="rr-theme-custom-input" />
				</label>
			</div>
			<Show when={s().theme === "custom"}><div class="rr-hint">Text colour is chosen automatically for contrast ({contrastColor(s().customBg)}).</div></Show>
			<label class="rr-check">
				<input type="checkbox" checked={s().justify} onChange={(e) => props.set({ justify: e.currentTarget.checked })} data-testid="rr-set-justify" />
				<span>Justify text</span>
			</label>
			<button class="rr-reset" onClick={props.reset}>Reset to defaults ({DEFAULT_SETTINGS.size}px {DEFAULT_SETTINGS.font})</button>
		</div>
	);
}
