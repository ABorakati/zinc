// The TAGS pane at the bottom of the sidebar (ui/src/Tags.tsx): filter box, tag pills with colour dots, click to filter the
// list (one tag at a time), right-click for colour / rename / delete, "..." menu for Show Automatic.
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { Rect } from "../ui/core";
import { Icon } from "../icons";
import { refreshStore, setTagFilter, tagFilter } from "../sidebar/bridge";
import { errMsg, sidebarApi } from "../sidebar/client";
import { promptText } from "../sidebar/dialogs";
import { IconButton, mode, muted, SectionHeader, t, tok, tx } from "../sidebar/parts";
import { collectionsFraction, setShowAutoTags, setTagsOpen, showAutoTags, tagsOpen } from "../sidebar/state";
import { store } from "../store";
import { Button, confirm, openDialog, openMenu, toast, type MenuItem } from "../ui";
import { boundsOf } from "../ui/core";
import {
	isAutomaticOnly, loadTags, setTagColor, tagColor, tags, tagsAge, tagsLoaded, tagsLoading, TAG_PALETTE, toggleTag, type TagCount,
} from "./state";

/** Same cap as the web UI: tens of thousands of pills would be too many nodes. */
const TAG_LIMIT = 500;
/**
 * Pills are mounted a chunk at a time as the pane scrolls. GPUIX builds, lays out and paints every node of a scroll container on every
 * frame, on screen or not, and a pill (box + label) costs ~70 us per frame: all 500 added ~34 ms to every frame of the window while the
 * tags pane was open (even when only the item list scrolled). A flowing, wrapping layout cannot go in a <virtual-list> (a row's pills
 * depend on their measured widths), so the pane keeps its flex-wrap layout, byte for byte, and just grows the mounted prefix when the
 * last mounted pill comes within one viewport of the visible area.
 */
const TAG_CHUNK = 48;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const EMOJI = /^[\p{Extended_Pictographic}‍️\p{Emoji_Modifier}\s]+$/u;

// ---- operations (ui/src/maintenance/ops.ts) ----

function reload() {
	void loadTags({ wantAutomatic: !showAutoTags() });
	refreshStore();
}

async function renameTag(tag: string) {
	const to = await promptText({ title: "Rename tag", description: "If a tag with the new name exists, the two are merged.", initial: tag, confirmLabel: "Rename" });
	if (!to || to === tag) return;
	try {
		const r = await sidebarApi.renameTag(tag, to, store.libraryId());
		if (tagFilter().includes(tag)) setTagFilter(tagFilter().map((x) => (x === tag ? to : x)));
		reload();
		toast(r.merged ? `Merged "${tag}" into "${to}"` : `Renamed "${tag}" to "${to}"`, { kind: "success", description: plural(r.items, "item") + " updated" });
	} catch (e) { toast("Could not rename tag", { kind: "error", description: errMsg(e) }); }
}

async function deleteTag(tag: string, count?: number) {
	const ok = await confirm({
		title: `Delete tag "${tag}"?`,
		body: `The tag will be removed from ${count === undefined ? "all items" : plural(count, "item")} in your library.`,
		confirmLabel: "Delete Tag",
		danger: true,
	});
	if (!ok) return;
	try {
		const r = await sidebarApi.deleteTags([tag], store.libraryId());
		setTagFilter(tagFilter().filter((x) => x !== tag));
		reload();
		toast(`Deleted tag "${tag}"`, { kind: "success", description: plural(r.items, "item") + " updated" });
	} catch (e) { toast("Could not delete tag", { kind: "error", description: errMsg(e) }); }
}

async function deleteAutomaticTags() {
	try {
		const auto = await sidebarApi.automaticTags(store.libraryId());
		if (!auto.length) return void toast("There are no automatic tags in this library");
		const ok = await confirm({
			title: "Delete automatic tags?",
			body: `${plural(auto.length, "automatic tag")} will be removed from all items in your library. Manually added tags are kept.`,
			confirmLabel: "Delete Automatic Tags",
			danger: true,
		});
		if (!ok) return;
		const r = await sidebarApi.deleteAutomaticTags(store.libraryId());
		const names = new Set(auto.map((a) => a.tag));
		setTagFilter(tagFilter().filter((x) => !names.has(x)));
		reload();
		toast(`Deleted ${plural(r.tags, "automatic tag")}`, { kind: "success", description: plural(r.items, "item") + " updated" });
	} catch (e) { toast("Could not delete automatic tags", { kind: "error", description: errMsg(e) }); }
}

// ---- colour dialog ----

function ColorPicker(p: { tag: string; close: () => void }): JSX.Element {
	const cur = () => tagColor(p.tag)?.color.toLowerCase();
	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<div style={t("flex flex-wrap gap-2")}>
				<For each={TAG_PALETTE}>{(c) => (
					<div
						role="button"
						aria-label={c.name}
						onClick={() => { void setTagColor(p.tag, c.color); p.close(); }}
						style={{
							...t("flex w-20 cursor-pointer flex-col items-center gap-1 rounded-lg py-2 hover:bg-accent"),
							cursor: "pointer",
							...(cur() === c.color.toLowerCase() ? { outlineWidth: 2, outlineColor: tok("primary"), outlineOffset: -2 } : {}),
						}}
					>
						<div style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c.color }} />
						<text style={tx("text-xs text-secondary-foreground")}>{c.name}</text>
					</div>
				)}</For>
			</div>
			<div style={t("flex justify-end gap-2")}>
				<Show when={tagColor(p.tag)}>
					<Button variant="outline" size="sm" onClick={() => { void setTagColor(p.tag, null); p.close(); }}>Remove colour</Button>
				</Show>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
			</div>
		</div>
	);
}

function assignColour(tag: string) {
	void openDialog<void>((close) => <ColorPicker tag={tag} close={() => close()} />, { title: `Colour for "${tag}"`, width: 330 });
}

function tagMenu(tag: TagCount): MenuItem[] {
	return [
		{ label: "Assign Colour…", icon: "palette", onSelect: () => assignColour(tag.tag) },
		...(tagColor(tag.tag) ? [{ label: "Remove colour", icon: "circle-slash", onSelect: () => void setTagColor(tag.tag, null) } satisfies MenuItem] : []),
		{ separator: true },
		{ label: "Rename Tag…", icon: "pencil", onSelect: () => void renameTag(tag.tag) },
		{ label: "Delete Tag…", icon: "trash-2", danger: true, onSelect: () => void deleteTag(tag.tag, tag.count) },
	];
}

function paneMenu(x: number, y: number) {
	openMenu({ x, y }, [
		{ label: "Show Automatic", checked: showAutoTags(), onSelect: () => setShowAutoTags(!showAutoTags()) },
		...(tagFilter().length ? [{ label: "Deselect All", icon: "x", onSelect: () => setTagFilter([]) } satisfies MenuItem] : []),
		{ separator: true },
		{ label: "Delete Automatic Tags in This Library…", icon: "trash-2", danger: true, onSelect: () => void deleteAutomaticTags() },
	]);
}

// ---- pills ----

function Pill(p: { tag: TagCount; onEl?: (el: HostElement | undefined) => void }): JSX.Element {
	const sel = () => tagFilter().includes(p.tag.tag);
	const colour = () => tagColor(p.tag.tag);
	const emoji = () => EMOJI.test(p.tag.tag);
	const [menu, setMenu] = createSignal(false);
	return (
		<div
			ref={(el: HostElement) => { p.onEl?.(el); onCleanup(() => p.onEl?.(undefined)); }}
			role="button"
			aria-pressed={sel()}
			aria-label={`${p.tag.tag}, ${p.tag.count} items`}
			onClick={() => toggleTag(p.tag.tag)}
			onAuxClick={(e) => {
				if (!e.isRightClick) return;
				setMenu(true);
				setTimeout(() => setMenu(false), 3000);
				openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, tagMenu(p.tag));
			}}
			style={{
				...t("inline-flex h-6 max-w-full cursor-default items-center gap-1.5 rounded-full bg-background px-2.5 ring-1 ring-border hover:ring-primary/50"),
				flexShrink: 0,
				cursor: "pointer",
				...(sel() ? { ...t("bg-primary-tint ring-primary-line"), hover: t("ring-primary-line") } : {}),
				...(menu() && !sel() ? { backgroundColor: tok("accent") } : {}),
			}}
		>
			<Show when={colour()}>
				<div style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, backgroundColor: colour()!.color }} />
			</Show>
			<text
				style={{
					...tx(sel() ? "text-xs font-medium text-primary-deep" : "text-xs text-secondary-foreground"),
					...(emoji() ? { fontSize: 14 } : {}),
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
					maxWidth: 220,
				}}
			>
				{p.tag.tag}
			</text>
		</div>
	);
}

export function TagList(): JSX.Element {
	const [filter, setFilter] = createSignal("");
	// load while open; refresh at most every 30 s when the list was reset (items edited elsewhere), and when "Show Automatic" flips
	let timer: ReturnType<typeof setTimeout> | undefined;
	let revTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));
	createEffect(on(tagsOpen, (open) => {
		if (open && (!tagsLoaded() || tagsAge() > 30_000)) void loadTags({ wantAutomatic: !showAutoTags() });
	}));
	createEffect(on(() => store.listVersion(), () => {
		clearTimeout(timer);
		if (!tagsOpen() || !tagsLoaded() || tagsAge() < 30_000) return;
		timer = setTimeout(() => void loadTags({ wantAutomatic: !showAutoTags() }), 1500);
	}, { defer: true }));
	// an edit in the item pane (tags added or removed) changes the counts: reload shortly after, whatever the age of the list
	createEffect(on(() => store.itemsRev(), () => {
	clearTimeout(revTimer);
	if (!tagsOpen() || !tagsLoaded()) return;
	revTimer = setTimeout(() => void loadTags({ wantAutomatic: !showAutoTags() }), 1500);
	}, { defer: true }));
	onCleanup(() => clearTimeout(revTimer));
	// another library has other tags
	createEffect(on(() => store.libraryId(), () => void loadTags({ wantAutomatic: !showAutoTags() }), { defer: true }));
	createEffect(on(showAutoTags, (show) => { if (!show && tagsOpen() && tagsLoaded()) void loadTags({ wantAutomatic: true }); }, { defer: true }));

	const lower = createMemo(() => tags().map((x) => x.tag.toLowerCase()));
	// Coloured tags first in Zotero's position order, then the rest as the API lists them (alphabetical).
	const filtered = createMemo(() => {
		const q = filter().trim().toLowerCase();
		const hideAuto = !showAutoTags();
		const l = lower();
		const list: TagCount[] = [];
		tags().forEach((x, i) => {
			if (q && !l[i]!.includes(q)) return;
			if (hideAuto && !tagColor(x.tag) && isAutomaticOnly(x)) return;
			list.push(x);
		});
		const pos = (name: string) => tagColor(name)?.position ?? Infinity;
		return list.sort((a, b) => pos(a.tag) - pos(b.tag));
	});
	const shown = createMemo(() => {
		const top = filtered().slice(0, TAG_LIMIT);
		// selected tags stay visible even when they fall beyond the cap
		const have = new Set(top.map((x) => x.tag));
		const extra = tagFilter().filter((x) => !have.has(x)).map((x) => tags().find((y) => y.tag === x) ?? { tag: x, count: 0 });
		return [...extra, ...top];
	});

	// the mounted prefix of `shown()` (see TAG_CHUNK)
	const [limit, setLimit] = createSignal(TAG_CHUNK);
	const mounted = createMemo(() => shown().slice(0, limit()));
	createEffect(on(filter, () => setLimit(TAG_CHUNK), { defer: true }));
	const pillEls = new Map<number, HostElement>();
	let box: HostElement | undefined;
	let check: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(check));
	/** Mount another chunk when the last mounted pill ends less than one viewport below the top of the visible area's bottom edge. */
	function more() {
		const n = Math.min(limit(), shown().length);
		if (n >= shown().length) return;
		const c: Rect | null = boundsOf(box);
		const b: Rect | null = boundsOf(pillEls.get(n - 1));
		if (!c || !b) return;
		if (b.y < c.y + c.height * 2) setLimit(Math.min(shown().length, n + TAG_CHUNK));
	}
	// bounds exist once a frame has painted: look again shortly after anything that changes what is mounted or how much room there is
	const soon = () => { clearTimeout(check); check = setTimeout(more, 60); };
	createEffect(() => { limit(); shown().length; tagsOpen(); tagsLoaded(); soon(); });

	return (
		<div style={{ ...t("flex min-h-0 flex-col"), flexGrow: tagsOpen() ? 1 - collectionsFraction() : 0, flexShrink: tagsOpen() ? 1 : 0, flexBasis: tagsOpen() ? 0 : undefined }}>
			<SectionHeader
				label="Tags"
				open={tagsOpen()}
				onToggle={() => setTagsOpen(!tagsOpen())}
				icon="tag"
				actions={<IconButton name="ellipsis" box={20} icon={14} label="Tag menu" onClick={(e) => paneMenu(e.x ?? 0, e.y ?? 0)} />}
			/>
			<Show when={tagsOpen()}>
				<div style={{ ...t("mx-2.5 mb-2 flex h-7 flex-none items-center rounded-lg bg-muted"), position: "relative" }}>
					<input
						value={filter()}
						placeholder="Filter tags"
						onChange={(e) => setFilter((e as { value?: string }).value ?? "")}
						style={{ flexGrow: 1, minWidth: 0, height: 28, paddingLeft: 10, paddingRight: 10, fontSize: 13, fontFamily: "Inter", color: tok("foreground") }}
						theme={{
							appearance: mode(),
							bg: tok("muted"),
							text: tok("foreground"),
							textMuted: tok("muted-foreground"),
							textFaint: tok("muted-foreground"),
							textDim: tok("muted-foreground"),
							accent: tok("primary"),
							caret: tok("primary"),
							fontSans: "Inter",
						}}
					/>
				</div>
				<div
					ref={(el: HostElement) => { box = el; }}
					onScrollChange={more}
					onLayout={soon}
					style={{ ...t("flex min-h-0 flex-wrap content-start gap-1.5 overflow-y-auto px-2.5 pb-2"), flexGrow: 1, flexShrink: 1, flexBasis: 0 }}
				>
					<Show
						when={tagsLoaded()}
						fallback={
							<For each={[48, 64, 40, 56, 72]}>{(w) => <div style={{ ...t("h-6 rounded-full bg-muted"), width: w }} />}</For>
						}
					>
						{/* Index, not For: GPUIX loses a moved element's event handlers, and a tag that gets a colour or is selected changes position */}
						<Index each={mounted()}>{(x, i) => <Pill tag={x()} onEl={(el) => { if (el) pillEls.set(i, el); else pillEls.delete(i); }} />}</Index>
						<Show when={filtered().length > TAG_LIMIT && limit() >= shown().length}>
							<div style={t("inline-flex h-6 items-center px-2")}>
								<text style={tx("text-xs text-muted-foreground")}>{`+ ${(filtered().length - TAG_LIMIT).toLocaleString("en-US")} more`}</text>
							</div>
						</Show>
						<Show when={tagsLoaded() && !tagsLoading() && filtered().length === 0}>
							<text style={tx("text-xs text-muted-foreground")}>{tags().length ? "No matching tags" : "No tags"}</text>
						</Show>
					</Show>
				</div>
			</Show>
		</div>
	);
}

void muted;
void Icon;
