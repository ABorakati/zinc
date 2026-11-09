// "Full text" quick-search mode: search results with snippets instead of the item list (SearchResults in ui/src/ItemTable.tsx).
// GET /api/search matches titles, metadata, notes and PDF full text; each hit carries an FTS5 snippet with <mark> around matches,
// drawn as one <text> with `highlight` ranges (GPUIX has no inline spans).
import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { api, type SearchHit } from "../api";
import { store } from "../store";
import { mix } from "./logic";
import { textStyle, tokens, tw } from "../theme";
import { fail, openItem } from "./actions";
import { modsOf } from "./click";

/** An FTS5 snippet -> plain text + [start, end) ranges of the <mark>ed parts (other tags dropped, entities decoded). */
export function parseSnippet(html: string): { text: string; ranges: [number, number][] } {
	const ranges: [number, number][] = [];
	let text = "";
	let open = -1;
	const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
	for (const part of html.split(/(<\/?[a-zA-Z][^>]*>)/)) {
		if (/^<mark[\s>]/i.test(part)) open = text.length;
		else if (/^<\/mark>/i.test(part)) { if (open >= 0 && text.length > open) ranges.push([open, text.length]); open = -1; }
		else if (/^<\/?[a-zA-Z]/.test(part)) continue;
		else text += dec(part);
	}
	return { text: text.replace(/\s+/g, (m) => (m.includes("\n") ? " " : m)), ranges };
}

export function SearchResults(): JSX.Element {
	const [hits, setHits] = createSignal<SearchHit[]>([]);
	const [total, setTotal] = createSignal(0);
	const [busy, setBusy] = createSignal(false);
	const [err, setErr] = createSignal<string | null>(null);
	let n = 0;
	const m = () => store.mode();
	const tok = (name: string) => tokens[m()][name]!;

	createEffect(() => {
		const q = store.filter().trim();
		const lib = store.libraryId(); // read here, not in the timer: the search re-runs when the library on screen changes
		const id = ++n;
		if (!q) { setHits([]); setTotal(0); setBusy(false); return; }
		setBusy(true);
		const timer = setTimeout(async () => {
			try {
				const r = await api.search(q, 200, 0, undefined, lib);
				if (id !== n) return;
				setHits(r.hits); setTotal(r.total); setErr(null);
			} catch (e) {
				if (id === n) { setErr(String((e as Error)?.message ?? e)); fail("Search failed", e); }
			} finally { if (id === n) setBusy(false); }
		}, 250);
		onCleanup(() => clearTimeout(timer));
	});

	const matchColor = () => mix(tok("primary"), 30, "transparent");
	return (
		<div style={{ ...tw("flex flex-col flex-1 min-h-0 w-full bg-card", m()), height: "100%" }}>
			<div style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, width: "100%", overflowY: "scroll", scrollbarColor: tok("input"), scrollbarWidth: 6, display: "flex", flexDirection: "column" }}>
				<For each={hits()}>{(h) => {
					const snip = parseSnippet(h.snippet);
					const sel = () => store.selected().has(h.key);
					return (
						<div
							onClick={(e: EventPayload) => {
								if (modsOf(e).ctrl) store.setSelected(new Set(sel() ? [...store.selected()].filter((k) => k !== h.key) : [...store.selected(), h.key]));
								else store.selectOnly(h.key);
								if ((e.clickCount ?? 1) >= 2) void openItem({ key: h.key, itemType: "journalArticle", title: h.title, attachmentCount: 1 });
							}}
							style={{
								...tw("flex flex-col flex-none border-b border-border/40 px-4 py-2 cursor-pointer hover:bg-accent/50", m()),
								...(sel() ? { backgroundColor: mix(tok("primary"), 10, tok("card")) } : {}),
							}}
						>
							<text style={textStyle("font-semibold text-foreground", m())}>{h.title || "(untitled)"}</text>
							<text style={textStyle("text-xs text-muted-foreground", m())}>{`${h.creatorsSummary ?? ""}${h.year ? ` (${h.year})` : ""} · ${h.matchedIn.join(", ")}`}</text>
							<text style={{ ...textStyle("text-xs text-foreground mt-0.5", m()), marginTop: 2 }} highlight={snip.ranges.length ? { ranges: snip.ranges, color: matchColor(), radius: 2 } : null}>{snip.text}</text>
						</div>
					);
				}}</For>
				<Show when={!busy() && !hits().length}>
					<div style={tw("flex justify-center p-6", m())}>
						<text style={textStyle("text-muted-foreground", m())}>{store.filter().trim() ? "No matches" : "Type to search titles, notes and full text"}</text>
					</div>
				</Show>
			</div>
			<div style={tw("flex flex-none border-t border-border bg-card px-2 py-0.5", m())}>
				<text style={textStyle("text-xs text-muted-foreground", m())}>{`${total().toLocaleString("en-GB")} hits${busy() ? " · searching…" : ""}${err() ? ` · ${err()}` : ""}`}</text>
			</div>
		</div>
	);
}
