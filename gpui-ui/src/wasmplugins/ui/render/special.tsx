// canvas (vector draw list -> SVG image, host-side hit testing, pan and zoom), web-view (a sandboxed WebView2 over a placeholder) and
// embed (Zinc's own components drawn with the plugin's data).
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import type { EventPayload, HostElement } from "@gpuix/solid";
import { api } from "../../../api";
import { ipApi } from "../itempane-bridge";
import { Icon } from "../../../icons";
import { t, tok, tx, boundsOf, hideTooltip, overlayLayers, showTooltip } from "../../../ui/core";
import { floatingRects } from "../../../ui/overlay";
import { WebHost, webViewHeadless, webViewSupported } from "../../../webview/host";
import { withAlpha } from "../../../theme";
import { buildCanvas, hitTest, type HitShape, type View } from "../canvasSvg";
import { P } from "../controller";
import { readPackageFile, svgUrl } from "../l10n";
import { resolveColor } from "../colors";
import { useRt, type KindComponent } from "./ctx";
import { imageUrl } from "./content";
import { UiIcon } from "./icons";
import { modsOf } from "./node";
import { acceptPageMessage, allowedOrigins, allowedUrl, deliverScript, sandboxInit, wrapperUrl } from "./webSandbox";

// ---------------------------------------------------------------------------------------------------- canvas

const CanvasK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const full = (): View => ({ x: 0, y: 0, width: spec().width ?? 100, height: spec().height ?? 100 });
	const fromSpec = (): View => {
		const v = spec().view as (View & { zoom?: number }) | undefined;
		return v ? { x: v.x, y: v.y, width: v.width, height: v.height } : full();
	};
	const [view, setView] = createSignal<View>(untrack(fromSpec));
	createEffect(on(() => JSON.stringify(spec().view ?? null), () => setView(fromSpec()), { defer: true }));
	const built = createMemo(() =>
		buildCanvas(spec(), view(), {
			mode: rt.mode(),
			txt: (x) => rt.txt(x),
			image: (src) => imageUrl(rt, src).url,
		}),
	);
	const url = createMemo(() => svgUrl(built().svg));
	let el: HostElement | undefined;
	let hits: HitShape[] = [];
	createEffect(() => {
		hits = built().hits;
	});
	/** Window coordinates -> canvas coordinates (the image keeps its aspect ratio inside the box: xMidYMid meet). */
	const toCanvas = (e: EventPayload): { x: number; y: number } | undefined => {
		const b = boundsOf(el);
		if (!b || b.width <= 0 || b.height <= 0) return undefined;
		const v = view();
		const s = Math.min(b.width / v.width, b.height / v.height);
		const ox = (b.width - v.width * s) / 2,
			oy = (b.height - v.height * s) / 2;
		return { x: v.x + ((e.x ?? 0) - b.x - ox) / s, y: v.y + ((e.y ?? 0) - b.y - oy) / s };
	};
	const zoomOf = () => full().width / view().width;
	const emitView = () => {
		const v = view();
		rt.ctl.fire(p.node, "view-changed", P.viewBox(v.x, v.y, v.width, v.height, zoomOf()));
	};
	let drag: { x: number; y: number; view: View; scale: number } | undefined;
	const pointer = (e: EventPayload, button?: number) => {
		const c = toCanvas(e);
		if (!c) return undefined;
		const h = hitTest(hits, c.x, c.y);
		return P.pointer(c.x, c.y, { button: button ?? e.button ?? 0, hit: h?.id });
	};
	const fireIf = (kind: "pointer-down" | "pointer-move" | "pointer-up", e: EventPayload) => {
		if (!rt.ctl.has(p.node, kind)) return;
		const pl = pointer(e);
		if (pl) rt.ctl.fire(p.node, kind, pl, modsOf(e));
	};
	const aspect = () => (spec().width ?? 100) / Math.max(1, spec().height ?? 100);
	let viewTimer: ReturnType<typeof setTimeout> | undefined;
	const emitViewSoon = () => {
		if (viewTimer) clearTimeout(viewTimer);
		viewTimer = setTimeout(emitView, 120);
	};
	onCleanup(() => viewTimer && clearTimeout(viewTimer));
	return (
		<div
			{...p.handlers}
			ref={(x: HostElement) => {
				el = x;
				p.reg(x);
			}}
			onClick={(e: EventPayload) => {
				const pl = pointer(e);
				if (pl) rt.ctl.fire(p.node, "press", pl, modsOf(e));
				if (!pl) (p.handlers.onClick as (e: EventPayload) => void)(e);
			}}
			onMouseDown={(e: EventPayload) => {
				fireIf("pointer-down", e);
				const b = boundsOf(el);
				if (spec().panZoom && b && (e.button ?? 0) === 0) drag = { x: e.x ?? 0, y: e.y ?? 0, view: view(), scale: Math.min(b.width / view().width, b.height / view().height) };
			}}
			onMouseUp={(e: EventPayload) => {
				fireIf("pointer-up", e);
				if (drag) {
					drag = undefined;
					emitView();
				}
			}}
			onMouseMove={(e: EventPayload) => {
				if (drag && e.pressedButton !== undefined && e.pressedButton !== null) {
					const dx = ((e.x ?? 0) - drag.x) / drag.scale,
						dy = ((e.y ?? 0) - drag.y) / drag.scale;
					setView({ ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy });
					return;
				}
				if (drag) {
					drag = undefined;
					emitView();
				}
				fireIf("pointer-move", e);
				const c = toCanvas(e);
				const h = c ? hitTest(hits, c.x, c.y) : undefined;
				if (h?.tip) showTooltip({ label: h.tip, rect: null, pointer: { x: e.x ?? 0, y: e.y ?? 0 } });
				else hideTooltip();
			}}
			onMouseLeave={() => hideTooltip()}
			onScroll={(e: EventPayload) => {
				const dy = e.deltaY ?? 0;
				if (rt.ctl.has(p.node, "wheel")) {
					const c = toCanvas(e);
					rt.ctl.fire(p.node, "wheel", P.pointer(c?.x ?? 0, c?.y ?? 0, { deltaX: e.deltaX ?? 0, deltaY: dy }), modsOf(e));
				}
				if (!spec().panZoom || !dy) return;
				const c = toCanvas(e);
				if (!c) return;
				const f = dy < 0 ? 1 / 1.15 : 1.15; // wheel up zooms in (smaller visible region)
				const v = view();
				const w = Math.min(full().width * 8, Math.max(full().width / 40, v.width * f));
				const k = w / v.width;
				setView({ x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k, width: w, height: v.height * k });
				emitViewSoon();
			}}
			style={{ display: "flex", flexDirection: "column", aspectRatio: aspect(), width: "100%", overflow: "hidden", cursor: spec().panZoom ? "grab" : "default", ...p.box() }}
		>
			<img src={url()} objectFit="contain" style={{ width: "100%", height: "100%", pointerEvents: "none" }} />
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- web-view

const MAX_PER_PLUGIN = 2;
const MAX_TOTAL = 4;
const live = new Map<string, Set<symbol>>();
const total = () => [...live.values()].reduce((n, s) => n + s.size, 0);

/** Web-view hosts by `<instance>|<key>`, so `ui.web-post-message` can reach the page. */
export const webHosts = new Map<string, { post: (json: string) => void }>();

const WebViewK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const id = Symbol("web-view");
	let el: HostElement | undefined;
	let host: WebHost | undefined;
	const reason = (): string | undefined => {
		if (!rt.has("ui.webview")) return "This plugin has no permission to show web content (ui.webview).";
		if (!webViewSupported()) return "Web content is not available in this build (WebView2 / WebKitGTK missing).";
		const s = live.get(rt.pluginId) ?? new Set();
		if (!s.has(id) && s.size >= MAX_PER_PLUGIN) return `A plugin can show at most ${MAX_PER_PLUGIN} web views.`;
		if (!s.has(id) && total() >= MAX_TOTAL) return `At most ${MAX_TOTAL} web views can be open at once.`;
		return undefined;
	};
	const [blocked, setBlocked] = createSignal<string | undefined>(untrack(reason));
	// What the view shows and how it is sandboxed. The top-level page is always the host-built wrapper (webSandbox.ts); plugin content only
	// lives in its sandboxed iframe. Anything that changes the plan (source, scripts, messaging, allowed hosts) builds a new view.
	const plan = createMemo(
		(): { url?: string; shown?: string; note?: string; messaging: boolean } => {
			const sp = spec();
			const s = sp.source as { tag: string; val: string } | undefined;
			const scripts = !!sp.sandbox?.scripts;
			const messaging = scripts && !!sp.messaging;
			if (!s) return { note: "This web view has no source.", messaging };
			const origins = allowedOrigins(sp.allowHosts, rt.netHosts());
			if (s.tag === "url") {
				const href = allowedUrl(s.val, origins);
				if (!href) return { note: `${s.val} is not an https address on the plugin's allowed hosts.`, messaging };
				return { url: wrapperUrl({ kind: "url", value: href, scripts, origins }), shown: href, messaging };
			}
			const html = s.tag === "html" ? s.val : new TextDecoder().decode(readPackageFile(rt.dir(), s.val) ?? new Uint8Array());
			if (!html) return { note: `Missing page ${s.val}`, messaging };
			return { url: wrapperUrl({ kind: "srcdoc", value: html, scripts, origins }), shown: "about:blank", messaging };
		},
		undefined,
		{ equals: (a, b) => a.url === b.url && a.note === b.note && a.messaging === b.messaging },
	);
	onMount(() => {
		const r = untrack(reason);
		if (r) return;
		let set = live.get(rt.pluginId);
		if (!set) live.set(rt.pluginId, (set = new Set()));
		set.add(id);
		const key = `${rt.ctl.instance}|${p.node.props.key ?? ""}`;
		const stop = () => {
			webHosts.delete(key);
			host?.release(0);
			host = undefined;
		};
		onCleanup(stop);
		createEffect(() => {
			const pl = plan();
			stop();
			if (!pl.url) {
				setBlocked(pl.note);
				rt.ctl.fire(p.node, "web", { tag: "web", val: { url: String(spec().source?.val ?? ""), phase: "blocked" } });
				return;
			}
			setBlocked(undefined);
			const nonce = crypto.randomUUID();
			const h = new WebHost({
				init: sandboxInit(pl.messaging, nonce),
				onMessage: (m) => {
					const a = acceptPageMessage(m, nonce, pl.messaging);
					if (a !== null) rt.ctl.fire(p.node, "message", P.message(a));
				},
				follow: true,
			});
			host = h;
			const bg = resolveColor(spec().background, rt.mode());
			h.setBackground(bg && bg.startsWith("#") ? bg : tok("background"));
			if (pl.messaging)
				webHosts.set(key, {
					post: (json) => {
						const js = deliverScript(json);
						if (js) h.eval(js);
					},
				});
			h.show(pl.url, () => (overlayLayers().length > 0 || !el ? null : { rect: boundsOf(el)!, holes: floatingRects() }));
			rt.ctl.fire(p.node, "web", { tag: "web", val: { url: pl.shown ?? "about:blank", phase: "loaded" } });
		});
	});
	onCleanup(() => {
		host?.release(0);
		live.get(rt.pluginId)?.delete(id);
	});
	return (
		<div
			{...p.handlers}
			ref={(x: HostElement) => {
				el = x;
				p.reg(x);
			}}
			style={{ ...t("flex items-center justify-center rounded-md border bg-card"), minHeight: 120, width: "100%", ...p.box() }}
		>
			<Show when={blocked() ?? reason()} fallback={<text style={tx("text-xs text-muted-foreground")}>{webViewHeadless() ? "(web view, headless)" : "Loading..."}</text>}>
				{(msg) => (
					<div style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center", padding: 12 }}>
						<Icon name="globe-lock" size={16} color={tok("muted-foreground")} />
						<text style={tx("text-xs text-muted-foreground")}>{msg()}</text>
					</div>
				)}
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- embed

type ItemDetailLite = Awaited<ReturnType<typeof ipApi.item>>;

const Box = (p: { title: string; children: JSX.Element }) => (
	<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
		<text style={{ ...tx("text-[11px] font-semibold text-muted-foreground"), whiteSpace: "nowrap" }}>{p.title.toUpperCase()}</text>
		{p.children}
	</div>
);
const Muted = (p: { children: string }) => <text style={tx("text-[13px] text-muted-foreground")}>{p.children}</text>;
const Row2 = (p: { label: string; value: string }) => (
	<div style={{ display: "flex", flexDirection: "row", gap: 8 }}>
		<text style={{ ...tx("text-xs text-muted-foreground"), width: 96, flexShrink: 0 }}>{p.label}</text>
		<text style={{ ...tx("text-[13px] text-foreground"), flexShrink: 1, minWidth: 0 }}>{p.value}</text>
	</div>
);

function creatorName(c: { firstName?: string; lastName?: string; name?: string }): string {
	return c.name ?? [c.lastName, c.firstName].filter(Boolean).join(", ");
}

function useItem(key: () => string | undefined) {
	return createResource(key, async (k) => {
		try {
			return await ipApi.item(k);
		} catch {
			return null;
		}
	});
}

const EmbedK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const params = createMemo((): Record<string, any> => {
		try {
			return JSON.parse(spec().params || "{}");
		} catch {
			return {};
		}
	});
	const comp = () => spec().component as string;
	const [item] = useItem(() => (["item-box", "abstract-box", "tags-box", "notes-box", "attachments-box", "related-box", "libraries-collections-box"].includes(comp()) ? (params().item as string | undefined) : undefined));
	const denied = () => !rt.has("library.read") && comp() !== "style-picker" && comp() !== "search-builder";
	const body = (): JSX.Element => {
		const it = (): ItemDetailLite | null | undefined => item();
		switch (comp()) {
			case "item-box":
				return (
					<Show when={it()} fallback={<Muted>{item.loading ? "Loading..." : "Item not found"}</Muted>}>
						{(d) => (
							<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
								<Row2 label="Item type" value={d().data.itemType} />
								<Row2 label="Title" value={d().data.title ?? ""} />
								<For each={d().data.creators ?? []}>{(c) => <Row2 label={c.creatorType} value={creatorName(c)} />}</For>
								<Show when={d().data.date}>
									<Row2 label="Date" value={d().data.date!} />
								</Show>
								<Show when={d().data.publicationTitle}>
									<Row2 label="Publication" value={d().data.publicationTitle!} />
								</Show>
								<Show when={d().data.DOI}>
									<Row2 label="DOI" value={d().data.DOI!} />
								</Show>
							</div>
						)}
					</Show>
				);
			case "abstract-box":
				return (
					<Box title="Abstract">
						<text style={tx("text-[13px] text-foreground")}>{it()?.data.abstractNote || "No abstract"}</text>
					</Box>
				);
			case "tags-box":
				return (
					<Box title="Tags">
						<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
							<For each={it()?.tags ?? []} fallback={<Muted>No tags</Muted>}>
								{(tg) => (
									<div style={{ ...t("flex h-5 items-center rounded-full px-2"), backgroundColor: tok("primary-tint") }}>
										<text style={{ ...tx("text-xs font-medium"), color: tok("primary-deep"), whiteSpace: "nowrap" }}>{tg.tag}</text>
									</div>
								)}
							</For>
						</div>
					</Box>
				);
			case "notes-box":
			case "attachments-box": {
				const kind = comp() === "notes-box" ? "note" : "attachment";
				return (
					<Box title={kind === "note" ? "Notes" : "Attachments"}>
						<For each={(it()?.children ?? []).filter((c) => c.itemType === kind)} fallback={<Muted>{kind === "note" ? "No notes" : "No attachments"}</Muted>}>
							{(c) => (
								<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
									<Icon name={kind === "note" ? "sticky-note" : "paperclip"} size={14} color={tok("muted-foreground")} />
									<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{c.title || c.key}</text>
								</div>
							)}
						</For>
					</Box>
				);
			}
			case "related-box":
				return (
					<Box title="Related">
						<For each={it()?.related ?? []} fallback={<Muted>No related items</Muted>}>
							{(r) => (
								<div style={{ display: "flex", flexDirection: "row", gap: 6 }}>
									<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.title}</text>
									<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{r.creatorsSummary}</text>
								</div>
							)}
						</For>
					</Box>
				);
			case "libraries-collections-box":
				return (
					<Box title="Libraries and collections">
						<Muted>{it() ? `${it()!.collections.length} collection(s)` : "Loading..."}</Muted>
					</Box>
				);
			case "item-picker":
				return <ItemPicker params={params()} onPick={(keys) => rt.ctl.fire(p.node, "embed", P.message(JSON.stringify({ selected: keys })))} />;
			case "collection-picker":
				return <CollectionPicker params={params()} onPick={(keys) => rt.ctl.fire(p.node, "embed", P.message(JSON.stringify({ selected: keys })))} />;
			default:
				return (
					<div style={{ ...t("flex items-center gap-2 rounded-md border border-dashed p-3") }}>
						<UiIcon icon={{ tag: "builtin", val: "puzzle" }} size={16} color={tok("muted-foreground")} />
						<text style={tx("text-xs text-muted-foreground")}>{`"${comp()}" is not available in this build of Zinc.`}</text>
					</div>
				);
		}
	};
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<Show
				when={!denied()}
				fallback={
					<div style={{ ...t("flex items-center gap-2 rounded-md border border-dashed p-3") }}>
						<Icon name="lock" size={14} color={tok("muted-foreground")} />
						<text style={tx("text-xs text-muted-foreground")}>This plugin has no permission to read the library (library.read).</text>
					</div>
				}
			>
				{body()}
			</Show>
		</div>
	);
};

function ItemPicker(p: { params: Record<string, any>; onPick: (keys: string[]) => void }): JSX.Element {
	const [q, setQ] = createSignal("");
	const [sel, setSel] = createSignal<string[]>([]);
	const [rows] = createResource(q, async (text) => {
		try {
			return (await api.items({ sort: "title", dir: "asc", q: text || undefined } as never, 0, 30)).items;
		} catch {
			return [];
		}
	});
	return (
		<div style={{ ...t("flex flex-col rounded-md border"), height: 220 }}>
			<div style={{ ...t("flex h-8 items-center gap-1.5 border-b px-2") }}>
				<Icon name="search" size={14} color={tok("muted-foreground")} />
				<input value={q()} placeholder="Search items" onChange={(e: EventPayload) => setQ(e.value ?? "")} style={{ flexGrow: 1, fontSize: 13, height: 26, keyboardFocusDim: false, color: tok("foreground") }} theme={{ appearance: "light", bg: tok("background"), text: tok("foreground") }} />
			</div>
			<div style={{ overflow: "scroll", flexGrow: 1, minHeight: 0, scrollbarColor: withAlpha(tok("foreground"), 0.25), scrollbarWidth: 6 }}>
				<For each={rows() ?? []}>
					{(r) => (
						<div
							onClick={() => {
								const next = p.params.multiple ? (sel().includes(r.key) ? sel().filter((k) => k !== r.key) : [...sel(), r.key]) : [r.key];
								setSel(next);
								p.onPick(next);
							}}
							style={{ ...t("flex h-7 items-center px-2"), cursor: "pointer", backgroundColor: sel().includes(r.key) ? tok("primary-tint") : "transparent", hover: { backgroundColor: tok("accent") } }}
						>
							<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.title}</text>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

function CollectionPicker(p: { params: Record<string, any>; onPick: (keys: string[]) => void }): JSX.Element {
	const [tree] = createResource(async () => {
		try {
			return await api.collections(p.params.library);
		} catch {
			return [];
		}
	});
	const [sel, setSel] = createSignal<string | undefined>();
	const flat = createMemo(() => {
		const out: { key: string; name: string; depth: number }[] = [];
		const walk = (list: { key: string; name: string; children?: any[] }[], depth: number) => {
			for (const c of list) {
				out.push({ key: c.key, name: c.name, depth });
				walk(c.children ?? [], depth + 1);
			}
		};
		walk(tree() ?? [], 0);
		return out;
	});
	return (
		<div style={{ ...t("flex flex-col rounded-md border"), height: 200, overflow: "scroll", scrollbarColor: withAlpha(tok("foreground"), 0.25), scrollbarWidth: 6 }}>
			<For each={flat()}>
				{(c) => (
					<div
						onClick={() => {
							setSel(c.key);
							p.onPick([c.key]);
						}}
						style={{ ...t("flex h-7 items-center gap-1.5 px-2"), paddingLeft: 8 + c.depth * 14, flexShrink: 0, cursor: "pointer", backgroundColor: sel() === c.key ? tok("primary-tint") : "transparent", hover: { backgroundColor: tok("accent") } }}
					>
						<Icon name="folder" size={14} color={tok("muted-foreground")} />
						<text style={{ ...tx("text-[13px] text-foreground"), whiteSpace: "nowrap" }}>{c.name}</text>
					</div>
				)}
			</For>
		</div>
	);
}

export const special: Record<string, KindComponent> = { canvas: CanvasK, "web-view": WebViewK, embed: EmbedK };
