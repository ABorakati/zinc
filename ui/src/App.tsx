import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { BookOpen, BookOpenText, FileText, Library as LibraryIcon, LayoutList, PanelLeft, PanelRight, Search, Settings, Table2, X } from "lucide-solid";
import { toast } from "solid-sonner";
import { CollectionsPane } from "./Collections";
import { TagList } from "./Tags";
import { ItemTable, SearchResults } from "./ItemTable";
import { ItemPane } from "./ItemPane";
import { FullTextProgress } from "./fulltext/Progress";
import { findFullText } from "./lib/fulltext";
import { SyncStatus } from "./sync/SyncStatus";
import { appActions, overlays } from "./lib/registry";
import "./features";
import { QuickSearchMode } from "./searches/QuickSearchMode";
import { Plus, Wrench } from "lucide-solid";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuGroupLabel, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
	DropdownMenuShortcut, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/** Toolbar dropdown for registered app actions ("+" add menu or Tools). Hidden while empty. */
const ActionMenu: Component<{ menu: "add" | "tools"; label: string; primary?: boolean }> = (p) => {
	const list = () => appActions().filter((a) => a.menu === p.menu);
	return (
		<Show when={list().length}>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger
						as={DropdownMenuTrigger}
						class={p.primary
							? "inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-primary hover:bg-primary/90 [&_svg]:size-3.5"
							: "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground [&_svg]:size-4"}
						aria-label={p.label}
					>
						{p.menu === "add" ? <Plus /> : <Wrench />}
						<Show when={p.primary}>Add</Show>
					</TooltipTrigger>
					<TooltipContent>{p.label}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent class="w-60">
					<For each={list()}>{(a) => (
						<DropdownMenuItem onSelect={() => a.run()}>
							<Show when={a.icon}>{(I) => { const C = I(); return <C class="mr-2 size-4" />; }}</Show>
							{a.label}
							<Show when={a.shortcut}><DropdownMenuShortcut>{a.shortcut}</DropdownMenuShortcut></Show>
						</DropdownMenuItem>
					)}</For>
				</DropdownMenuContent>
			</DropdownMenu>
		</Show>
	);
};
import { ReferencesPanel } from "./references/ReferencesPanel";
import { api } from "./api";
import { store, SETTINGS_TAB } from "./store";
import { SettingsPage } from "./settings/SettingsPage";
import { defaultReader, persistedFlag, READERS, refsOpen, setDefaultReader, setRefsOpen, type PdfReader } from "./settings/prefs";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Resizable, ResizableHandle, ResizablePanel } from "~/components/ui/resizable";
import { Toaster } from "~/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

/** Pane sizes (fractions summing to 1) persisted in localStorage; storage may be unavailable. */
function persistedSizes(key: string, fallback: number[]) {
	const k = "zn.sizes." + key;
	const load = () => {
		try {
			const v = JSON.parse(localStorage.getItem(k) ?? "null");
			if (Array.isArray(v) && v.length === fallback.length && v.every((n) => typeof n === "number" && n > 0)) return v as number[];
		} catch {}
		return fallback;
	};
	const [sizes, setSizes] = createSignal(load());
	return [sizes, (s: number[]) => {
		setSizes(s);
		try { localStorage.setItem(k, JSON.stringify(s)); } catch {}
	}] as const;
}

/** Sidebar and item-pane visibility, toggled from the top bar ("zn.flag.panelLeft" / "zn.flag.panelRight"). */
const [leftOpen, setLeftOpen] = persistedFlag("panelLeft", true);
const [rightOpen, setRightOpen] = persistedFlag("panelRight", true);

/** "Open in library" from a citation: open the item's PDF beside the current tab, else show it in the library. */
async function revealItem(key: string) {
	try {
		const d = await api.item(key);
		const att = d.children.find((c) => c.itemType === "attachment" && c.hasFile && /pdf|epub/i.test(c.contentType ?? ""));
		if (att) return store.openAttachment(att.key, d.data.title ?? att.title);
		store.setActiveTab("library");
		store.setSelected(new Set([key]));
		store.setActiveKey(key);
	} catch (e) {
		toast.error("Could not open item", { description: e instanceof Error ? e.message : String(e) });
	}
}

const VIEW_MODES = [
	{ mode: "cards" as const, label: "Card view", text: "List", icon: LayoutList },
	{ mode: "table" as const, label: "Table view", text: "Classic", icon: Table2 },
];

const Toolbar: Component = () => (
	<div class="flex flex-none items-center gap-2.5 border-b border-border-soft px-4 pt-3.5 pb-2.5">
		<QuickSearchMode class="h-9 rounded-lg" />
		<div class="relative flex-1">
			<Search class="pointer-events-none absolute left-3 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground" />
			<Input
				class="h-9 rounded-lg border-transparent bg-muted pl-9 shadow-none"
				type="search"
				placeholder={store.fulltext() ? "Search full text…" : "Search titles, authors, year…"}
				value={store.filter()}
				onInput={(e) => store.setFilter(e.currentTarget.value)}
			/>
		</div>
		<div role="group" aria-label="View" class="inline-flex rounded-lg bg-muted p-[3px]">
			<For each={VIEW_MODES}>{(m) => (
				<Tooltip>
					<TooltipTrigger as="button" type="button" aria-label={m.label} aria-pressed={store.viewMode() === m.mode} data-view={m.mode}
						class={cn("inline-flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-3.5",
							store.viewMode() === m.mode && "bg-background font-medium text-foreground shadow-sm hover:text-foreground")}
						onClick={() => store.setViewMode(m.mode)}>
						<m.icon /> {m.text}
					</TooltipTrigger>
					<TooltipContent>{m.label}</TooltipContent>
				</Tooltip>
			)}</For>
		</div>
		<ActionMenu menu="tools" label="Tools" />
		<ActionMenu menu="add" label="Add items" primary />
	</div>
);

/** Resize handle that reads as a 12px gutter between the raised cards. */
const GutterHandle: Component = () => (
	<ResizableHandle class="w-3 bg-transparent after:w-1 after:rounded-full hover:bg-transparent hover:after:bg-primary/40 data-[dragging]:bg-transparent data-[dragging]:after:bg-primary" />
);
const card = "min-w-0 rounded-[14px] bg-background shadow-raised";

/** The panels present for one combination of sidebar / item-pane visibility; remounted when that combination changes. */
const LibraryPanels: Component<{ k: string }> = (p) => {
	const left = p.k[0] === "1", right = p.k[1] === "1";
	const defaults = { "11": [0.18, 0.54, 0.28], "10": [0.22, 0.78], "01": [0.64, 0.36], "00": [1] } as Record<string, number[]>;
	const [cols, setCols] = persistedSizes(p.k === "11" ? "cols" : "cols-" + p.k, defaults[p.k]);
	return (
		<Resizable sizes={cols()} onSizesChange={setCols} class="h-full">
			<Show when={left}>
				<ResizablePanel minSize={0.1} class="min-w-0">
					<div class="zn-sidebar flex h-full min-h-0 flex-col gap-3 px-2.5 pt-1.5 pb-1">
						<CollectionsPane />
						<TagList />
					</div>
				</ResizablePanel>
				<GutterHandle />
			</Show>
			<ResizablePanel minSize={0.25} class={cn(card, "flex flex-col overflow-hidden")}>
				<Toolbar />
				<Show when={store.fulltext()} fallback={<ItemTable />}>
					<SearchResults />
				</Show>
			</ResizablePanel>
			<Show when={right}>
				<GutterHandle />
				<ResizablePanel minSize={0.15} class={cn(card, "overflow-y-auto")}>
					<ItemPane />
				</ResizablePanel>
			</Show>
		</Resizable>
	);
};

const Library: Component = () => (
	// the canvas shows around the cards: 12px above, right and below; the sidebar carries its own left padding
	<div class="h-full pt-3 pr-3 pb-3" classList={{ "pl-3": !leftOpen() }}>
		<For each={[`${+leftOpen()}${+rightOpen()}`]}>{(k) => <LibraryPanels k={k} />}</For>
	</div>
);

export const App: Component = () => {
	const onKey = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
			e.preventDefault();
			store.closeTab(store.activeTab());
		}
	};
	// References panel beside each reader (one toggle for all tabs), and the reference
	// a citation popup asked to show, per tab.
	const [refsFocus, setRefsFocus] = createSignal<Record<string, { index: number }>>({});

	// Per tab: whether it is a PDF (only PDFs can switch reader) and the reader chosen for it.
	const [isPdf, setIsPdf] = createSignal<Record<string, boolean>>({});
	const [tabReader, setTabReader] = createSignal<Record<string, PdfReader>>({});
	createEffect(() => {
		for (const t of store.tabs()) {
			if (t.kind !== "reader" || t.id in isPdf()) continue;
			setIsPdf({ ...isPdf(), [t.id]: false });
			api.item(t.attachmentKey)
				.then((d) => setIsPdf({ ...isPdf(), [t.id]: /pdf/i.test(String(d.data.contentType ?? "")) }))
				.catch(() => {});
		}
	});
	const onReader = () => store.tabs().find((t) => t.id === store.activeTab())?.kind === "reader";
	const readerFor = (id: string): PdfReader => (isPdf()[id] ? (tabReader()[id] ?? defaultReader()) : "zotero");
	const readerSrc = (t: { id: string; attachmentKey: string }) =>
		`/${readerFor(t.id) === "next" ? "reader-next" : "reader-host"}/index.html?attachment=${encodeURIComponent(t.attachmentKey)}`;
	const chooseReader = (r: PdfReader) => {
		setTabReader({ ...tabReader(), [store.activeTab()]: r });
		setDefaultReader(r);
	};

	// Messages from reader pages: links to open, items to reveal, references to show.
	const onMessage = (e: MessageEvent) => {
		if (e.origin !== location.origin || !e.data || typeof e.data.type !== "string") return;
		const m = e.data;
		if (m.type === "open-link" && typeof m.url === "string") {
			fetch("/api/open-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: m.url }),
			}).catch(() => {});
		} else if (m.type === "open-item" && typeof m.key === "string") {
			revealItem(m.key);
		} else if (m.type === "show-references" && typeof m.index === "number") {
			setRefsOpen(true);
			setRefsFocus({ ...refsFocus(), [store.activeTab()]: { index: m.index } });
		} else if (m.type === "open-attachment" && typeof m.key === "string") {
			store.openAttachment(m.key, typeof m.title === "string" ? m.title : "");
		} else if (m.type === "reference-added") {
			store.bumpItems();
		} else if (m.type === "find-fulltext" && Array.isArray(m.keys) && m.keys.every((k: unknown) => typeof k === "string")) {
			findFullText(m.keys);
		}
	};
	onMount(() => {
		window.addEventListener("keydown", onKey);
		window.addEventListener("message", onMessage);
	});
	onCleanup(() => {
		window.removeEventListener("keydown", onKey);
		window.removeEventListener("message", onMessage);
	});
	// Reader pages are same-origin: let Ctrl+W close the tab while the reader has focus.
	// (Key presses inside the reader's own nested view frames still don't reach here.)
	const watchFrameKeys = (e: Event) => {
		try {
			(e.currentTarget as HTMLIFrameElement).contentWindow?.addEventListener("keydown", onKey);
		} catch {}
	};

	const tabCls = (active: boolean) =>
		cn(
			"group relative flex h-7 max-w-56 flex-none cursor-default items-center gap-1.5 rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground",
			active && "bg-background font-medium text-foreground shadow-sm ring-1 ring-border hover:bg-background",
		);
	const onLibrary = () => store.activeTab() === "library";
	const panelBtn = (on: boolean) =>
		cn(
			"inline-flex size-7 flex-none items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4",
			on ? "bg-border text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
		);

	return (
		<div class="flex h-full flex-col">
			<div class="flex h-10 flex-none items-center gap-1 border-b bg-topbar px-3">
				<Tooltip>
					<TooltipTrigger
						as="button"
						type="button"
						class={panelBtn(leftOpen())}
						aria-label={leftOpen() ? "Hide sidebar" : "Show sidebar"}
						aria-pressed={leftOpen()}
						disabled={!onLibrary()}
						onClick={() => setLeftOpen(!leftOpen())}
					>
						<PanelLeft />
					</TooltipTrigger>
					<TooltipContent>{leftOpen() ? "Hide sidebar" : "Show sidebar"}</TooltipContent>
				</Tooltip>
				<div role="tablist" class="flex min-w-0 items-center gap-1 overflow-x-auto py-1 pr-1 pl-0.5">
				<div role="tab" aria-selected={onLibrary()} class={tabCls(onLibrary())} onClick={() => store.setActiveTab("library")}>
					<LibraryIcon class="size-3.5" /> Library
				</div>
				<For each={store.tabs()}>
					{(t) => (
						<div
							role="tab"
							aria-selected={store.activeTab() === t.id}
							class={cn(tabCls(store.activeTab() === t.id), "pr-1")}
							title={t.title}
							onClick={() => store.setActiveTab(t.id)}
							onAuxClick={(e) => e.button === 1 && store.closeTab(t.id)}
						>
							<Show when={t.kind === "settings"} fallback={<FileText class="size-3.5 flex-none" />}><Settings class="size-3.5 flex-none" /></Show>
							<span class="truncate" classList={{ "opacity-50": store.isUnloaded(t.id) }} title={store.isUnloaded(t.id) ? "Unloaded to save memory; click to reopen" : undefined}>{t.title || "Reader"}</span>
							<Tooltip>
								<TooltipTrigger
									as="button"
									class="inline-flex size-[22px] flex-none items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
									aria-label="Close tab"
									onClick={(e: MouseEvent) => {
										e.stopPropagation();
										store.closeTab(t.id);
									}}
								>
									<X class="size-3" />
								</TooltipTrigger>
								<TooltipContent>Close tab (Ctrl+W)</TooltipContent>
							</Tooltip>
						</div>
					)}
				</For>
				</div>
				<div class="ml-auto flex flex-none items-center gap-1">
				<Show when={onReader() && isPdf()[store.activeTab()]}>
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger
								as={DropdownMenuTrigger}
								class="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground [&_svg]:size-3.5"
								aria-label="PDF reader"
							>
								<BookOpen /> {readerFor(store.activeTab()) === "next" ? "Zotero Next reader" : "Zotero reader"}
							</TooltipTrigger>
							<TooltipContent>Choose the PDF reader (remembered for new tabs)</TooltipContent>
						</Tooltip>
						<DropdownMenuContent class="w-64">
							<DropdownMenuRadioGroup value={readerFor(store.activeTab())} onChange={(v: string) => chooseReader(v === "next" ? "next" : "zotero")}>
								<DropdownMenuGroupLabel>Open PDFs in</DropdownMenuGroupLabel>
								<For each={READERS}>{(r) => (
									<DropdownMenuRadioItem value={r.id} closeOnSelect>
										<div class="flex flex-col">
											<span>{r.label}</span>
											<span class="text-[11px] text-muted-foreground">{r.hint}</span>
										</div>
									</DropdownMenuRadioItem>
								)}</For>
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</Show>
				{/* reader-next has its own References tab, so the side panel is only for Zotero's reader. */}
				<Show when={onReader() && readerFor(store.activeTab()) === "zotero"}>
					<Tooltip>
						<TooltipTrigger
							as={Button}
							variant="ghost"
							size="sm"
							class={cn("h-7 gap-1 rounded-md px-2.5 text-xs", refsOpen() && "text-primary")}
							aria-pressed={refsOpen()}
							onClick={() => setRefsOpen(!refsOpen())}
						>
							<BookOpenText /> References
						</TooltipTrigger>
						<TooltipContent>Show or hide this paper's references</TooltipContent>
					</Tooltip>
				</Show>
				{/* Zotero sync: refresh lists when changes arrive from Zotero. */}
				<SyncStatus onChanged={() => { store.bumpItems(); store.bumpCollections(); store.bumpTags(); }} />
				<Tooltip>
					<TooltipTrigger
						as="button"
						type="button"
						class={panelBtn(rightOpen())}
						aria-label={rightOpen() ? "Hide item pane" : "Show item pane"}
						aria-pressed={rightOpen()}
						disabled={!onLibrary()}
						onClick={() => setRightOpen(!rightOpen())}
					>
						<PanelRight />
					</TooltipTrigger>
					<TooltipContent>{rightOpen() ? "Hide item pane" : "Show item pane"}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						as="button"
						type="button"
						class={cn("inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground [&_svg]:size-4", store.activeTab() === SETTINGS_TAB && "text-primary")}
						aria-label="Settings"
						data-testid="open-settings"
						onClick={() => store.openSettings()}
					>
						<Settings />
					</TooltipTrigger>
					<TooltipContent>Settings (Ctrl+,)</TooltipContent>
				</Tooltip>
				</div>
			</div>
			<div class="relative min-h-0 flex-1">
				<div class="absolute inset-0" classList={{ hidden: store.activeTab() !== "library" }}>
					<Library />
				</div>
				<For each={store.tabs()}>
					{(t) => (
						<div class="absolute inset-0 flex" classList={{ hidden: store.activeTab() !== t.id }}>
							<Show when={t.kind === "reader"} fallback={<SettingsPage active={store.activeTab() === t.id} />}>
								<Show when={!store.isUnloaded(t.id)} fallback={<div class="flex h-full min-w-0 flex-1 items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>}>
									<iframe ref={(el) => store.registerFrame(t.id, el)} class="h-full min-w-0 flex-1 border-0 bg-background" src={readerSrc(t)} title={t.title} onLoad={watchFrameKeys} />
								</Show>
								<Show when={refsOpen() && readerFor(t.id) === "zotero"}>
									<ReferencesPanel
										class="h-full w-[340px] flex-none border-l"
										itemKey={t.attachmentKey}
										onOpenItem={revealItem}
										onAdded={() => store.bumpItems()}
										focus={refsFocus()[t.id] ?? null}
									/>
								</Show>
							</Show>
						</div>
					)}
				</For>
			</div>
			<FullTextProgress />
			<For each={overlays()}>{(o) => o.render()}</For>
			{/* bottom centre: the Find Full Text panel owns the bottom-right corner */}
			<Toaster position="bottom-center" closeButton visibleToasts={3} />
		</div>
	);
};
