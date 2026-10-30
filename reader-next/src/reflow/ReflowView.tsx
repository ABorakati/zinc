// The reflowed reading view: DocStructure as a clean article with user typography.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { DocStructure, PdfRect, ViewerHandle } from "../contract";
import { bestTarget, buildItems, firstItemOnPage, tocEntries, type ReflowItem } from "./build";
import { READING_CSS } from "./css";
import {
	contrastColor, DEFAULT_SETTINGS, FONTS, fontStack, isFontInstalled, LIMITS, palette, type ReadingSettings, type ThemeKind,
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
const TOC_KEY = "rn.reading.toc";

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
			if (el.getBoundingClientRect().bottom > top) { topPage = Number(p); break; }
		}
		trackSection(top);
	};
	const onScroll = () => { if (!raf) raf = requestAnimationFrame(trackTop); };

	// ------------------------------------------------------------ contents (from the headings the layout analysis found,
	// so it works for PDFs without bookmarks)
	const toc = createMemo(() => tocEntries(items()));
	// pinned: always shown; auto: a slim tab at the edge that opens on hover; closed: only the "Contents" button.
	// Where it sits (dragged by its header) is remembered too.
	type TocPrefs = { mode: "pinned" | "auto" | "closed"; x?: number; y?: number };
	const [tocPrefs, setTocPrefsRaw] = createSignal<TocPrefs>((() => {
		try {
			const v = JSON.parse(localStorage.getItem(TOC_KEY) ?? "null") as TocPrefs | null;
			if (v && (v.mode === "pinned" || v.mode === "auto" || v.mode === "closed")) return v;
		} catch { /* storage unavailable or old format */ }
		return { mode: window.innerWidth >= 1200 ? "pinned" : "auto" };
	})());
	const setTocPrefs = (p: Partial<TocPrefs>) => {
		const next = { ...tocPrefs(), ...p };
		setTocPrefsRaw(next);
		try { localStorage.setItem(TOC_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
	};
	const [tocPeek, setTocPeek] = createSignal(false); // auto mode: open while hovered
	let peekTimer: ReturnType<typeof setTimeout> | undefined;
	const peek = (on: boolean) => { clearTimeout(peekTimer); if (on) setTocPeek(true); else peekTimer = setTimeout(() => setTocPeek(false), 450); };
	onCleanup(() => clearTimeout(peekTimer));
	const tocShown = () => tocPrefs().mode === "pinned" || (tocPrefs().mode === "auto" && tocPeek());
	/** Drag the panel by its header; the position is kept inside the view and remembered. */
	const startDrag = (e: PointerEvent) => {
		if ((e.target as HTMLElement).closest("button")) return;
		const nav = (e.currentTarget as HTMLElement).closest<HTMLElement>(".rr-toc")!;
		const host = nav.offsetParent as HTMLElement;
		const r = nav.getBoundingClientRect(), h = host.getBoundingClientRect();
		const dx = e.clientX - r.left, dy = e.clientY - r.top;
		const move = (ev: PointerEvent) => {
			const x = Math.max(0, Math.min(ev.clientX - dx - h.left, h.width - r.width));
			const y = Math.max(0, Math.min(ev.clientY - dy - h.top, h.height - 40));
			nav.style.left = `${x}px`; nav.style.top = `${y}px`;
		};
		const up = () => {
			window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
			setTocPrefs({ x: parseFloat(nav.style.left), y: parseFloat(nav.style.top) });
		};
		window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
		e.preventDefault();
	};
	const tocPos = (): JSX.CSSProperties => {
		const p = tocPrefs();
		return p.x === undefined ? {} : { left: `${p.x}px`, top: `${p.y ?? 10}px` };
	};
	const [section, setSection] = createSignal<string | null>(null);
	/** The section being read: the last heading above the top of the view (with a little lead). */
	const trackSection = (top: number) => {
		let cur: string | null = null;
		for (const e of toc()) {
			const el = article?.querySelector<HTMLElement>(`[data-item="${CSS.escape(e.id)}"]`);
			if (!el) continue;
			if (el.getBoundingClientRect().top <= top + 80) cur = e.id; else break;
		}
		setSection(cur);
	};
	const goToSection = (id: string) => {
		const el = article?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);
		if (el) goToEl(el, "start");
	};

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

	// ------------------------------------------------------------ links within the reading view
	const blockById = createMemo(() => {
		const st = props.state();
		return new Map(st.phase === "ready" ? st.doc.blocks.map((b) => [b.id, b]) : []);
	});
	const back: number[] = [];
	const [backCount, setBackCount] = createSignal(0);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	/** Scroll to the item (or bibliography entry) holding PDF location (page, top), remembering where we were. */
	const goTo = (page: number, top?: number, citeNumber?: number): boolean => {
		if (!article) return false;
		const els = Array.from(article.querySelectorAll<HTMLElement>("[data-blocks]"));
		const map = blockById();
		const i = bestTarget(els.map((el) => ({ blocks: el.dataset.blocks!.split(" ").flatMap((id) => map.get(id) ?? []) })), page, top);
		const el = i >= 0 ? els[i] : article.querySelector<HTMLElement>(`[data-item="${CSS.escape(items()[firstItemOnPage(items(), page)]?.id ?? "")}"]`);
		if (!el) return false;
		// going to a citation of reference n: mark that citation itself, not the whole paragraph
		const a = citeNumber === undefined ? undefined
			: Array.from(el.querySelectorAll<HTMLElement>("a.rx-cite")).find((x) => (x.textContent ?? "").match(/\d+/g)?.includes(String(citeNumber)));
		goToEl(a ?? el);
		return true;
	};
	const goToEl = (el: HTMLElement, block?: ScrollLogicalPosition) => {
		if (!article) return;
		back.push(scroller.scrollTop);
		if (back.length > 30) back.shift();
		setBackCount(back.length);
		el.scrollIntoView({ block: block ?? (el.offsetHeight < scroller.clientHeight * 0.6 ? "center" : "start"), behavior: "smooth" });
		for (const f of article.querySelectorAll(".rr-flash")) f.classList.remove("rr-flash");
		void el.offsetWidth; // restart the animation
		el.classList.add("rr-flash");
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => el.classList.remove("rr-flash"), 1800);
	};
	const goBack = () => {
		const y = back.pop();
		setBackCount(back.length);
		if (y !== undefined) scroller.scrollTo({ top: y, behavior: "smooth" });
	};
	// other plugins (popups' "Go to" buttons) ask for a location; handled here instead of leaving the reading view
	const onGoto = (e: Event) => {
		const d = (e as CustomEvent<{ page: number; rect?: PdfRect; cite?: number }>).detail;
		if (d && Number.isFinite(d.page) && goTo(d.page, d.rect?.[3], d.cite)) e.preventDefault();
	};
	const onKey = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement | null;
		if (menuOpen() || !back.length || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
		if (e.key === "Escape" || (e.key === "ArrowLeft" && e.altKey)) { e.preventDefault(); goBack(); }
	};
	window.addEventListener("reader-next:reading-goto", onGoto);
	window.addEventListener("keydown", onKey);
	onCleanup(() => {
		window.removeEventListener("reader-next:reading-goto", onGoto);
		window.removeEventListener("keydown", onKey);
		clearTimeout(flashTimer);
	});

	// ------------------------------------------------------------ citations
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	const detailFor = (a: HTMLElement, e: MouseEvent, kind: "hover" | "click"): CitationDetail => {
		const top = Number(a.dataset.top);
		// a bare "," / "–" link inside a citation group stands for its neighbour's number
		const near = [a, a.nextElementSibling, a.previousElementSibling].find((el) => el?.matches("a.rx-cite") && /\d/.test(el.textContent ?? ""));
		return {
			page: Number(a.dataset.page), top: Number.isFinite(top) && a.dataset.top !== undefined ? top : undefined,
			text: (near ?? a).textContent ?? "", clientX: e.clientX, clientY: e.clientY, kind,
		};
	};
	const cite = (e: MouseEvent) => (e.target as HTMLElement | null)?.closest?.<HTMLElement>("a.rx-cite") ?? null;
	const onClick = (e: MouseEvent) => {
		const a = cite(e);
		const li = entryOf(e.target);
		if (!a && li && !(e.target as HTMLElement).closest("a")) {
			// a bibliography entry: the popup layer goes to its first citation
			clearTimeout(hoverTimer);
			const index = Array.prototype.indexOf.call(li.parentElement!.children, li) + 1;
			window.dispatchEvent(new CustomEvent("reader-next:bib-click", { detail: { text: li.textContent ?? "", index } }));
			return;
		}
		if (!a) return;
		e.preventDefault();
		clearTimeout(hoverTimer);
		window.dispatchEvent(new CustomEvent("reader-next:citation-leave"));
		// a click goes straight to the target in this view (hovering shows the popup)
		const entry = a.dataset.kind === "ref" ? refEntry(a) : null;
		if (entry) { goToEl(entry); return; }
		const d = detailFor(a, e, "click");
		if (Number.isFinite(d.page) && !goTo(d.page, d.top)) viewOnPage(d.page, d.top);
	};
	/**
	 * The bibliography entry a numbered citation link names. PDF link destinations are often only the top of the
	 * list or column, so the number is the better guide. Bare "," / "–" links in a group borrow a neighbour's number.
	 */
	const refEntry = (a: HTMLElement): HTMLElement | null => {
		const num = (el: Element | null) => (el?.matches("a.rx-cite") ? /\d+/.exec(el.textContent ?? "")?.[0] : undefined);
		const n = num(a) ?? num(a.nextElementSibling) ?? num(a.previousElementSibling);
		if (!n || !article) return null;
		const entries = Array.from(article.querySelectorAll<HTMLElement>(".rr-refs li"));
		const re = new RegExp(`^\\s*\\[?${n}(?![\\d])[\\].:)]?\\s`);
		return entries.find((li) => re.test(li.textContent ?? "")) ?? null;
	};
	const entryOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>(".rr-refs li") ?? null;
	const onOver = (e: MouseEvent) => {
		const li = entryOf(e.target);
		if (li && !cite(e)) {
			if (entryOf(e.relatedTarget) === li) return;
			// a bibliography entry: the popup layer shows where the paper cites it
			const index = Array.prototype.indexOf.call(li.parentElement!.children, li) + 1;
			const detail = { text: li.textContent ?? "", index, clientX: e.clientX, clientY: e.clientY };
			clearTimeout(hoverTimer);
			hoverTimer = setTimeout(() => window.dispatchEvent(new CustomEvent("reader-next:bib-hover", { detail })), 260);
			return;
		}
		const a = cite(e);
		if (!a) return;
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => window.dispatchEvent(new CustomEvent("reader-next:citation", { detail: detailFor(a, e, "hover") })), 220);
	};
	const onOut = (e: MouseEvent) => {
		const li = entryOf(e.target);
		if (li && !cite(e)) {
			if (entryOf(e.relatedTarget) === li) return;
			clearTimeout(hoverTimer);
			window.dispatchEvent(new CustomEvent("reader-next:citation-leave"));
			return;
		}
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
				<Show when={backCount() > 0}>
					<button class="rr-reading-btn" title="Back to where you were (Esc or Alt+←)" onClick={goBack} data-testid="rr-reading-back">← Back</button>
				</Show>
				<div class="rr-reading-group">
					<button class="rr-reading-btn" title="Smaller text" disabled={s().size <= LIMITS.size[0]} onClick={() => props.setSettings({ size: s().size - 1 })} data-testid="rr-size-down">A−</button>
					<button class="rr-reading-btn" title="Larger text" disabled={s().size >= LIMITS.size[1]} onClick={() => props.setSettings({ size: s().size + 1 })} data-testid="rr-size-up">A+</button>
				</div>
				<div class="rr-reading-group">
					<button class="rr-reading-btn" title="Narrower column" disabled={s().width <= LIMITS.width[0]} onClick={() => props.setSettings({ width: Math.max(LIMITS.width[0], s().width - 60) })} data-testid="rr-width-down">→←</button>
					<button class="rr-reading-btn" title="Wider column" disabled={s().width >= LIMITS.width[1]} onClick={() => props.setSettings({ width: Math.min(LIMITS.width[1], s().width + 60) })} data-testid="rr-width-up">←→</button>
				</div>
				<button class="rr-reading-btn" title="Fonts, size, width, theme and more" aria-expanded={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} data-testid="rr-reading-typo">
					<span style={{ "font-family": "Georgia, serif" }}>A</span><span style={{ "font-size": "0.75em", "font-family": "Georgia, serif" }}>a</span>
				</button>
				<button class="rr-reading-btn" title="Back to the PDF page view" onClick={() => props.close()} data-testid="rr-reading-close">PDF</button>
			</div>
			<Show when={menuOpen()}>
				<Typography settings={s} set={props.setSettings} reset={props.resetSettings} close={() => setMenuOpen(false)} />
			</Show>
			<Show when={toc().length >= 2}>
				<Show when={tocPrefs().mode === "closed"}>
					<button class="rr-reading-btn rr-toc-toggle" title="Show contents" onClick={() => setTocPrefs({ mode: "pinned" })} data-testid="rr-toc-open">☰ Contents</button>
				</Show>
				<Show when={tocPrefs().mode === "auto" && !tocPeek()}>
					{/* auto-hide: a small ☰ in the corner (hover or click) and an invisible strip along the left edge */}
					<button class="rr-reading-btn rr-toc-toggle rr-toc-icon" title="Contents" aria-label="Contents" data-testid="rr-toc-edge"
						onPointerEnter={() => peek(true)} onClick={() => peek(true)}>☰</button>
					<div class="rr-toc-hot" aria-hidden="true" onPointerEnter={() => peek(true)} />
				</Show>
				<Show when={tocShown()}>
					<nav class="rr-toc" classList={{ "rr-toc-auto": tocPrefs().mode === "auto" }} style={tocPos()} aria-label="Contents" data-testid="rr-toc"
						onPointerEnter={() => peek(true)} onPointerLeave={() => peek(false)}>
						<div class="rr-toc-head" onPointerDown={startDrag} title="Drag to move">
							<span>Contents</span>
							<span class="rr-toc-actions">
								<button class="rr-toc-btn" classList={{ on: tocPrefs().mode === "pinned" }} data-testid="rr-toc-pin"
									title={tocPrefs().mode === "pinned" ? "Unpin (hide until you hover the edge)" : "Pin open"}
									onClick={() => setTocPrefs({ mode: tocPrefs().mode === "pinned" ? "auto" : "pinned" })}>📌</button>
								<Show when={tocPrefs().x !== undefined}>
									<button class="rr-toc-btn" title="Put back at the side" onClick={() => setTocPrefs({ x: undefined, y: undefined })}>⇤</button>
								</Show>
								<button class="rr-toc-btn" title="Close contents" data-testid="rr-toc-close" onClick={() => { setTocPeek(false); setTocPrefs({ mode: "closed" }); }}>×</button>
							</span>
						</div>
						<For each={toc()}>{(e) => (
							<button class={`rr-toc-item rr-toc-l${e.level}`} classList={{ on: section() === e.id }} title={e.text}
								onClick={() => goToSection(e.id)}>{e.text}</button>
						)}</For>
					</nav>
				</Show>
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

const THEMES: { id: ThemeKind; label: string; bg: string; fg: string }[] = [
	{ id: "light", label: "Light", bg: "#fbfaf7", fg: "#1f1e1c" },
	{ id: "sepia", label: "Sepia", bg: "#f4ecd8", fg: "#3b2f22" },
	{ id: "dark", label: "Dark", bg: "#17181b", fg: "#dedcd6" },
];

function Typography(props: { settings: () => ReadingSettings; set: (p: Partial<ReadingSettings>) => void; reset: () => void; close: () => void }) {
	const s = props.settings;
	let pop!: HTMLDivElement;
	const [installed, setInstalled] = createSignal<boolean | null>(null);
	// fonts that are only used when installed here (Bookerly): checked once per popover
	const missing = new Set<string>(FONTS.filter((f) => "installed" in f && !isFontInstalled(f.installed)).map((f) => f.id));
	const fontButton = (f: (typeof FONTS)[number]) => (
		<button classList={{ on: s().font === f.id }} style={{ "font-family": f.stack }} onClick={() => props.set({ font: f.id })}
			title={missing.has(f.id) ? `${f.label} is not installed on this computer` : f.label} data-testid={`rr-font-${f.id}`}>
			{f.label}<Show when={missing.has(f.id)}><span class="rr-missing">not installed</span></Show>
		</button>
	);
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
			<div class="rr-pop-h">Serif</div>
			<div class="rr-seg">
				<For each={FONTS.filter((f) => f.group === "serif")}>{fontButton}</For>
			</div>
			<div class="rr-pop-h">Sans serif</div>
			<div class="rr-seg">
				<For each={FONTS.filter((f) => f.group === "sans")}>{fontButton}</For>
				<button classList={{ on: s().font === "custom" }} onClick={() => props.set({ font: "custom" })} data-testid="rr-font-custom">Other…</button>
			</div>
			<Show when={s().font === "custom"}>
				<input class="rr-text" type="text" placeholder="Any installed font, e.g. Georgia" value={s().customFont} spellcheck={false}
					onInput={(e) => props.set({ customFont: e.currentTarget.value })} data-testid="rr-font-custom-name" />
				<Show when={installed() !== null}><div class="rr-hint">{installed() ? "Found on this computer." : "Not found here; falling back to a serif font."}</div></Show>
			</Show>
			<Show when={missing.has(s().font)}>
				<div class="rr-hint">This font is not installed on this computer, so Literata is used instead.</div>
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
			<label class="rr-check">
				<input type="checkbox" checked={s().openByDefault} onChange={(e) => props.set({ openByDefault: e.currentTarget.checked })} data-testid="rr-set-default" />
				<span>Open PDFs in the reading view</span>
			</label>
			<button class="rr-reset" onClick={props.reset}>Reset to defaults ({DEFAULT_SETTINGS.size}px Charter)</button>
		</div>
	);
}
